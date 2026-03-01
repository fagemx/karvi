# Pipeline Automation Roadmap

> 目標：讓 GitHub Issue 進來後，Karvi 自動完成 issue-plan → issue-action → pr-review → fix → merge，不需人工介入。

## 1. 核心洞察：Skill = Step

使用者的手動工作流就是一系列 Claude Code skill 調用：

```
/issue-plan #123     → 研究 + 規劃 + 貼 issue comment
/issue-action #123   → 實作 + 開 PR
/pr-review           → 四點檢查 + 貼 review comment
「好 請修」           → 修 blocker + push
「merge」             → squash merge
```

Karvi 已有 `runtime-claude.js`，能 spawn `claude -p`（Claude Code headless），
且 headless agent 在 repo 目錄啟動時可讀取 `.claude/skills/`，擁有完整 Skill tool。

**因此不需要重寫 step objectives。每個 pipeline step 直接調用對應的 skill。**

---

## 2. 現有基礎設施

### 能用的

| 元件 | 說明 |
|------|------|
| `runtime-claude.js` | spawn `claude -p --output-format json`，agent 有完整工具鏈 |
| Step state machine | queued → running → succeeded/failed → dead，含 retry + backoff |
| Kernel auto-advance | step completed → route-engine → next_step → dispatch 下一步 |
| Failure classification | TEST_FAILURE, PERMISSION, ENVIRONMENT 等模式，自動分類 |
| Budget tracking | llm_calls, tokens, wall_clock_ms, max_steps 限制 |
| GitHub webhook | Issue created → auto-dispatch task（PR #112 已 merge） |
| Artifact chaining | 前一步的 output 可作為下一步的 input_refs |

### 已知 Bug（必須修）

**Bug 1: `parseStepResult` 掃錯對象**

`step-worker.js:71` 掃 raw stdout，但 claude runtime 的 stdout 是 JSON wrapper：

```
stdout = '{"result": "...agent text...\\nSTEP_RESULT:{...}", "session_id": "..."}'
```

`parseStepResult(stdout)` 找不到 `^STEP_RESULT:` 開頭的行（被包在 JSON 裡面）。

Fix（1 行）：
```javascript
// step-worker.js:71
// 改前：
const stepResult = parseStepResult(result.stdout);
// 改後：
const stepResult = parseStepResult(replyText) || parseStepResult(result.stdout);
```

`replyText`（line 69）= `rt.extractReplyText(parsed, stdout)` = `parsed.result`，
這才是 agent 的實際文字輸出，裡面有 `STEP_RESULT:` 那行。

**Bug 2: dispatch reject 導致 step 卡住**

`runtime-claude.js:59-63` 在 exit code ≠ 0 時 reject promise。
`step-worker.js:65` 的 `await rt.dispatch(plan)` 沒有 try/catch。
→ step 停在 `running` 直到 lock 過期，不會正確 transition to `failed`。

Fix（~10 行）：在 executeStep 中 wrap dispatch call with try/catch，
catch 時 transition step to failed + emit signal。

---

## 3. Step ↔ Skill 對映

| Pipeline Step | Skill 調用 | Agent Message |
|---|---|---|
| `plan` | `/issue-plan {issue_id}` | `Execute /issue-plan {issue_id}` |
| `implement` | `/issue-action` | `Execute /issue-action for issue #{issue_id}` |
| `review` | `/pr-review` | `Execute /pr-review` |
| `fix` (新) | *(無對應 skill)* | `Fix the blockers from the PR review, then push` |
| `merge` (新) | *(無對應 skill)* | `Merge the PR: gh pr merge --squash --delete-branch` |

### Skill 已經處理的事

| 擔心的問題 | Skill 如何解決 |
|---|---|
| Agent 不知道 codebase | `/issue-plan` 的 deep-research phase 會搜整個 codebase |
| 跨 step context（PR#, branch） | `/issue-action` 自己建 branch、開 PR、存 artifacts 在 `/tmp/deep-dive/` |
| Review 品質 | `/pr-review` 有完整四點檢查 + e7h4n 風格 |
| CI 修復 | `/issue-action` 內部呼叫 `/pr-check`，會 auto-fix lint/format |
| Conventional commits | `/commit` skill 強制 conventional commit spec |

### Skill 沒處理的事（需要補）

| 缺口 | 說明 | 處理方式 |
|------|------|---------|
| `fix` 沒有對應 skill | 手動流程是使用者說「好 請修」 | 新增 skill 或直接在 step message 寫指令 |
| `merge` 沒有對應 skill | 手動流程是使用者說「merge」 | step message 直接寫 `gh pr merge` 指令 |
| STEP_RESULT 輸出 | Skills 不會輸出 STEP_RESULT 格式 | 在 step message 尾部加指令要求 agent 輸出 |
| Human gate（plan 審批） | `/issue-plan` 加 `pending` label 等人看 | 自動化模式跳過，或 kernel 設 human_review gate |

---

## 4. 要做的事

### Phase 1：修 Bug + 接線（~20 行改動）

**4 個改動，讓 pipeline 能用 claude runtime 跑起來：**

#### 1a. 修 parseStepResult（step-worker.js, 1 行）

```javascript
// line 71: 先掃 extractReplyText 的結果，再 fallback 掃 raw stdout
const stepResult = parseStepResult(replyText) || parseStepResult(result.stdout);
```

#### 1b. 修 dispatch error handling（step-worker.js, ~10 行）

```javascript
// line 65: wrap with try/catch
let result;
try {
  result = await rt.dispatch(plan);
} catch (err) {
  // Dispatch failed (non-zero exit, timeout, etc.)
  // Transition step to failed instead of leaving it stuck in running
  const failBoard = helpers.readBoard();
  const failTask = (failBoard.taskPlan?.tasks || []).find(t => t.id === envelope.task_id);
  const failStep = failTask?.steps?.find(s => s.step_id === envelope.step_id);
  if (failStep && failStep.state === 'running') {
    stepSchema.transitionStep(failStep, 'failed', {
      error: err.message?.slice(0, 500) || 'dispatch error',
    });
    helpers.writeBoard(failBoard);
  }
  throw err; // re-throw for caller logging
}
```

#### 1c. 改 buildStepMessage 調用 skill（step-worker.js, ~15 行）

```javascript
function buildStepMessage(envelope) {
  // Map step type to skill invocation
  const STEP_SKILL_MAP = {
    plan:      (env) => `Execute /issue-plan ${env.input_refs.issue_number || env.task_id}`,
    implement: (env) => `Execute /issue-action for issue #${env.input_refs.issue_number || env.task_id}`,
    review:    (env) => `Execute /pr-review`,
    fix:       (env) => `Fix all blockers from the PR review. Read the review comment, fix each issue, commit, and push.`,
    merge:     (env) => `Merge the PR with: gh pr merge --squash --delete-branch. Then comment on issue #${env.input_refs.issue_number} that it's done.`,
  };

  const skillFn = STEP_SKILL_MAP[envelope.step_type];
  const skillMsg = skillFn ? skillFn(envelope) : `Complete the ${envelope.step_type} step.`;

  const lines = [
    skillMsg,
    '',
    `Task: ${envelope.task_id}`,
    `Step: ${envelope.step_id} (${envelope.step_type})`,
  ];

  if (envelope.input_refs.task_description) {
    lines.push('', `Task description: ${envelope.input_refs.task_description}`);
  }

  if (envelope.retry_context) {
    lines.push('', '⚠ RETRY CONTEXT:');
    lines.push(`  Attempt: ${envelope.retry_context.attempt}`);
    if (envelope.retry_context.previous_error) lines.push(`  Previous error: ${envelope.retry_context.previous_error}`);
    if (envelope.retry_context.failure_mode) lines.push(`  Failure mode: ${envelope.retry_context.failure_mode}`);
    if (envelope.retry_context.remediation_hint) lines.push(`  Hint: ${envelope.retry_context.remediation_hint}`);
  }

  // Instruct agent to output structured result at the end
  lines.push('', 'IMPORTANT: When you are completely done, output your result on the LAST line as:');
  lines.push('STEP_RESULT:{"status":"succeeded","summary":"one line summary of what you did"}');
  lines.push('Or on failure:');
  lines.push('STEP_RESULT:{"status":"failed","error":"what went wrong","failure_mode":"TEST_FAILURE","retryable":true}');

  return lines.join('\n');
}
```

#### 1d. 擴充 step types（step-schema.js, context-compiler.js, management.js）

```javascript
// step-schema.js
const STEP_TYPES = ['plan', 'implement', 'test', 'review', 'fix', 'merge'];

// context-compiler.js — STEP_OBJECTIVES 可以保持簡短（真正的指引在 skill 裡）
const STEP_OBJECTIVES = {
  plan:      'Research codebase and create implementation plan via /issue-plan skill.',
  implement: 'Implement changes and create PR via /issue-action skill.',
  test:      'Verify CI passes and run tests.',
  review:    'Review PR via /pr-review skill.',
  fix:       'Fix blockers identified in review.',
  merge:     'Merge approved PR.',
};

// management.js
const DEFAULT_STEP_PIPELINE = ['plan', 'implement', 'review', 'merge'];
// 注意：test 被 /issue-action 內部的 /pr-check 覆蓋，fix 只在 review fail 時插入
```

### Phase 2：Runtime 配置 + E2E 測試

```javascript
// board.json controls 加入：
{
  "preferred_runtime": "claude",
  "auto_dispatch": true,
  "use_step_pipeline": true
}
```

**E2E 驗證：**
1. 開一個小 issue（如 `feat: add version endpoint`）
2. 觸發 webhook 或手動 dispatch
3. 觀察 pipeline 是否 plan → implement → review → merge 全部跑完

**Level 衡量：**
- Level 1: plan step 成功跑完 `/issue-plan`，issue 上出現 plan comment
- Level 2: implement step 成功開 PR
- Level 3: review step 成功貼 review comment
- Level 4: merge step 成功 merge PR

### Phase 3：review→fix 循環（後續）

只有 E2E happy path 跑通後才做：
- route-engine 在 review failed (REVIEW_REJECTION) 時插入 fix step
- fix → review 再跑一次（最多 N 次）
- 超過限制 → human_review

---

## 5. 架構圖

```
GitHub Issue created
  │
  ▼
Webhook: POST /api/webhooks/github
  │
  ▼
integration-github.js: handleWebhook()
  → buildTaskFromIssue() → task object
  │
  ▼
routes/github.js: push task to board.json
  → tryAutoDispatch(taskId)
  │
  ▼
kernel.js: generateStepsForTask()
  → steps = [plan, implement, review, merge]  (all queued)
  → transition plan to running
  → contextCompiler.buildEnvelope(plan step)
  │
  ▼
step-worker.js: executeStep()
  → buildStepMessage() → "Execute /issue-plan #123 ..."
  → runtime-claude.js: spawn claude -p --output-format json
  │
  ▼
Claude Code headless session (in repo directory):
  → Sees /issue-plan skill in .claude/skills/
  → Executes full deep-dive: research → innovate → plan
  → gh issue comment, gh CLI, file ops, grep, etc.
  → Outputs: STEP_RESULT:{"status":"succeeded","summary":"Plan posted to issue #123"}
  │
  ▼
step-worker.js: parseStepResult(replyText)
  → status = succeeded
  → artifact stored
  → signal emitted: step_completed
  │
  ▼
kernel.js: onStepEvent()
  → routeEngine.decideNext() → action: next_step (implement)
  → contextCompiler.buildEnvelope(implement step)
  → stepWorker.executeStep() ... (repeat for each step)
  │
  ▼
All steps succeeded → task.status = 'approved'
```

---

## 6. 風險和限制

| 風險 | 影響 | 緩解 |
|------|------|------|
| `claude -p` token 消耗不可控 | 一個 step 可能花很多錢 | `--max-budget-usd` 限制（runtime-claude.js 已支援） |
| Skill 不輸出 STEP_RESULT | parseStepResult fallback 到 exit code | Step message 明確要求輸出；exit code fallback 能兜底 |
| `/issue-plan` 的 deep-dive artifacts 在 `/tmp/` | 下一個 step 是新 session，找不到 | Skill 的結果已貼到 issue comment；implement step 從 issue 讀 |
| Headless 沒有 CLAUDE.md | Agent 不知道 project conventions | `claude -p` 在 repo 目錄啟動，會讀 CLAUDE.md |
| `gh` CLI 權限 | 可能沒有 merge 權限 | 需要有 write access 的 GitHub token |
| fix→review 無限循環 | 卡住 + 燒錢 | budget max_steps 限制 + REMEDIATION_LIMITS |
| 並行 task 衝突 | 兩個 task 改同一檔案 | Karvi 是 sequential dispatch，暫時安全 |
| `/tmp/deep-dive/` 跨 session 不共享 | issue-action 找不到 plan artifacts | 用 `--resume sessionId` 延續 session，或從 issue comments 重建 |

---

## 7. 開放問題

### Q1: Pipeline 要不要保留 human gate？

手動流程在 plan 後等人審批。自動化模式有兩個選擇：

- **A. 全自動**：plan → implement → review → merge，零人工介入
- **B. Plan gate**：plan 後設 human_review，等人 approve 再繼續

建議 A 先跑（speed），失敗時 route-engine 自動 escalate 到 human_review。

### Q2: `/issue-plan` 的 deep-dive artifacts 怎麼跨 step 傳遞？

`/issue-plan` 產出 research.md, innovate.md, plan.md 在 `/tmp/deep-dive/{name}/`。
`/issue-action` 讀這些檔案來實作。

在 pipeline 中每個 step 是獨立 session，`/tmp/` 內容不共享。解法：

- **A. Resume session**：implement step 用 `--resume {sessionId}` 延續 plan session
- **B. Issue comments 即 artifacts**：`/issue-plan` 已把 plan 貼到 issue comment；
  `/issue-action` 從 issue comments 讀回來（skill 本身已支援這個 fallback）
- **C. Shared workspace**：所有 steps 用同一個 workingDir，artifacts 直接存在 repo 裡

建議 B（最不需要改動，skill 已有此邏輯）。

### Q3: 需要新增 `fix` 和 `merge` step types 嗎？

- `fix` 和 `merge` 沒有對應的 Claude Code skill
- `fix` 的邏輯等同「讀 review comment + 改 code + push」— 不需要 skill，直接在 message 裡寫指令
- `merge` 就一行 `gh pr merge`

**可以先不加新 step types**，用現有 4 types 跑：
- `plan` → `/issue-plan`
- `implement` → `/issue-action`（內部已含 commit, push, PR create, CI check）
- `review` → `/pr-review`
- 如果 review LGTM → task done（人手動 merge 或加一個 post-hook）

這樣 Phase 1 更小，先驗證 3 steps 能 E2E 跑通。
