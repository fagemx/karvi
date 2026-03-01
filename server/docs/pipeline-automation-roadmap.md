# Pipeline Automation — 技術現況與下一步

> 最後更新：2026-03-01（E2E 驗證通過後）

## 1. 已驗證的能力

2026-03-01 E2E 測試結果：GitHub Issue #114 觸發完整 pipeline，全自動完成。

```
03:18:40  webhook received → task GH-114 created → 3 steps generated
03:19:30  plan     → succeeded  ($0.35, 70s)   → kernel: next_step
03:22:56  implement→ succeeded  ($0.96, 206s)  → kernel: next_step
03:24:47  review   → succeeded  ($0.47, 111s)  → kernel: done
           → task status: approved
           → total: 6 min, $1.78
```

實際產出：
- `/issue-plan` 執行完整 deep-dive（research → innovate → plan），在 issue 上貼了 4 個 comments
- `/issue-action` 建了 branch `feat/version-endpoint-114`，寫了 3 個檔案（+27 行），建了 PR #115
- `/pr-review` 跑了四點檢查，貼了 review comment
- PR #115 格式正確：conventional commit、test plan、closes #114

## 2. 架構（已驗證）

```
GitHub Issue opened
  │
  ▼
POST /api/webhooks/github
  │ integration-github.js: handleWebhook()
  │ → buildTaskFromIssue() → push to board.json
  │ → tryAutoDispatch(taskId)
  │
  ▼
kernel.js: generateStepsForTask()
  → steps = [plan, implement, review]  (all queued)
  → transition step[0] to running
  │
  ▼
step-worker.js: executeStep()
  │ 1. buildStepMessage()
  │    → "Execute /issue-plan 114"
  │ 2. inject STEP_RESULT instruction via --append-system-prompt
  │ 3. clear AGENT_MODEL_MAP hints (Claude CLI 不認 API model IDs)
  │ 4. acquire lock (lock_expires_at)
  │ 5. dispatch to runtime
  │
  ▼
runtime-claude.js: dispatch()
  │ 1. resolveClaudePath() → 完整路徑 (Windows PATH workaround)
  │ 2. spawn(claude.exe, ['-p', '--output-format', 'json', ...])
  │    stdio: ['ignore', 'pipe', 'pipe']  ← stdin MUST be ignored
  │ 3. stdout accumulate → JSON.parse()
  │ 4. parse 成功 → resolve promise → taskkill /T /F 清場
  │
  ▼
Claude Code headless session (in repo directory):
  → 讀取 .claude/skills/、CLAUDE.md
  → 執行 skill 完整流程（gh CLI、file ops、grep、etc.）
  → 輸出: STEP_RESULT:{"status":"succeeded","summary":"..."}
  │
  ▼
step-worker.js: 收到 result
  │ 1. parseStepResult(replyText) → status, summary
  │ 2. write artifact
  │ 3. transitionStep → succeeded (or failed → auto-retry)
  │ 4. emit signal: step_completed
  │
  ▼
kernel.js: onStepEvent()
  → routeEngine.decideNext() → action: next_step | done | retry
  → next_step: buildEnvelope → executeStep (重複上面的流程)
  → done: task.status = 'approved', completedAt set
```

### Step ↔ Skill 對映

| Step | Agent Message | Skill | 做什麼 |
|------|--------------|-------|--------|
| plan | `Execute /issue-plan {issue_id}` | `/issue-plan` | 研究 codebase、設計方案、貼 issue comments |
| implement | `Execute /issue-action for issue #{issue_id}` | `/issue-action` | 建 branch、寫 code、跑測試、開 PR |
| review | `Execute /pr-review` | `/pr-review` | 四點檢查、貼 review comment |

### 完成偵測機制

```
Agent 做完 → 輸出 STEP_RESULT:{"status":"succeeded",...}
                                    ↓
runtime-claude.js: --output-format json
  → CLI 把完整結果包成 JSON（含 result text）
  → stdout 收到 JSON → JSON.parse 成功 → resolve
  → taskkill /T /F 殺掉 process tree（CLI 有已知 hang bug）
                                    ↓
step-worker.js: parseStepResult(replyText)
  → 從 result text 中 regex match STEP_RESULT
  → 拿到 status/summary/error/failure_mode
```

兩層保險：
1. **STEP_RESULT** — 主要信號，由 `--append-system-prompt` 注入指令
2. **Exit code** — fallback，exit 0 = succeeded, non-zero = failed

## 3. 關鍵修復（Root Causes）

### 3a. Windows PATH 解析失敗

**問題**：`spawn('claude', args, { env: {...process.env} })` 在 Windows 找不到 `claude`。

**根因**：`process.env` 在 Node.js 有 case-insensitive proxy（`PATH` 和 `Path` 都能讀）。`{...process.env}` spread 到普通物件後，proxy 消失，`PATH` 變成 case-sensitive。Node spawn 內部用 `Path`（或 `path`）查找 → 找不到。

**修復**：啟動時用 `where claude`（Windows）或直接用 `CLAUDE_CMD` 環境變數解析完整路徑。Unix 不受影響。

```javascript
// runtime-claude.js
function resolveClaudePath() {
  if (process.env.CLAUDE_CMD) return process.env.CLAUDE_CMD;
  if (process.platform === 'win32') {
    const p = execSync('where claude', { encoding: 'utf8' }).trim().split('\n')[0].trim();
    if (p && fs.existsSync(p)) return p;
  }
  return 'claude';
}
const CLAUDE_EXE = resolveClaudePath();
```

### 3b. stdin pipe 導致掛起

**問題**：`claude -p` spawn 後零 stdout/stderr，process 一直跑但不輸出。

**根因**：Claude CLI 在 stdin 是 pipe 時等待 stdin 輸入。Node.js `spawn()` 預設 stdin 是 pipe。

**修復**：`stdio: ['ignore', 'pipe', 'pipe']` — stdin 設為 ignore。

### 3c. stream-json flush/hang bug

**問題**：`--output-format stream-json` 在 Windows 上 stdout 不 flush，或完成後 process 不退出。

**根因**：Claude CLI 已知 bug（[#25629](https://github.com/anthropics/claude-code/issues/25629), [#25670](https://github.com/anthropics/claude-code/issues/25670)）。

**修復**：改用 `--output-format json`（不加 `--verbose`）。CLI 在任務完成後輸出一個完整 JSON 物件，parse 成功就 resolve，再 taskkill 清場。

### 3d. 其他已修復的問題

| 問題 | 修復 |
|------|------|
| CLAUDECODE env var 阻擋 nested session | `delete env.CLAUDECODE` |
| AGENT_MODEL_MAP 給出 API-only model IDs | `if (runtimeHint === 'claude') plan.modelHint = null` |
| dispatch reject 導致 step 卡 running | try/catch wrap + transitionStep to failed |
| parseStepResult 掃 raw stdout 找不到 | 先掃 `replyText`（parsed.result），再 fallback raw stdout |

## 4. 狀態機

### Step 狀態

```
queued ──→ running ──→ succeeded
                  └──→ failed ──→ queued (auto-retry, attempt < max)
                              └──→ dead  (attempt >= max_attempts)
```

- `max_attempts`: 3（預設）
- `backoff`: 5s × 2^(attempt-1)
- `timeout`: 300s（wall-clock safety net）

### Task 狀態

```
undefined ──→ (steps running) ──→ approved (all steps succeeded)
                              └──→ blocked  (dead letter)
```

### Route Engine 決策

| 條件 | Action | Rule |
|------|--------|------|
| step succeeded + 下一步 queued | `next_step` | `pipeline_advance` |
| step succeeded + 全部 done | `done` | `pipeline_complete` |
| step failed + retryable + attempts left | `retry` | `auto_retry` |
| step dead | `dead_letter` | `max_attempts_exceeded` |

## 5. 成本與效能

E2E #114 實測（簡單 issue：加一個 version endpoint）：

| Step | 時間 | 成本 | Tokens (in/out) |
|------|------|------|-----------------|
| plan | 70s | $0.35 | ~19K / ~5 |
| implement | 206s | $0.96 | ~est |
| review | 111s | $0.47 | ~est |
| **Total** | **387s (6.5 min)** | **$1.78** | — |

複雜 issue 預估會更高，但有 `--max-budget-usd` 限制。

## 6. 現有限制

| 限制 | 影響 | 緩解方案 |
|------|------|---------|
| `--output-format json` 無中間輸出 | 長任務期間看不到進度 | Wall-clock timeout 兜底；未來可考慮 stream-json（等 bug 修） |
| 每個 step 是獨立 session | 跨 step context 靠 GitHub（issue comments, PR）傳遞 | Skills 已設計為從 issue 讀 context |
| Windows-only 驗證 | Unix 路線未測試 | 架構上相容，PATH 問題只影響 Windows |
| 單一 runtime (Claude CLI) | 依賴 claude.exe 安裝在本機 | `getRuntime(hint)` 支援多 runtime；API runtime 可作 fallback |
| Sequential dispatch | 一次只跑一個 task | Karvi 設計如此，暫時安全 |
| 無 human gate | plan 直接進 implement，沒等人審批 | 可在 route-engine 加 human_review 條件 |

## 7. 對照 Grith Vision（grith-spec/spec#1）

### 已就緒

| 能力 | 對應元件 | 狀態 |
|------|---------|------|
| 任務派發 | Karvi board + webhook | ✅ E2E 驗證 |
| 多步驟執行 | step-worker + kernel auto-advance | ✅ E2E 驗證 |
| 品質管控 | review step + route-engine | ✅ E2E 驗證 |
| 自動重試 | step state machine + backoff | ✅ 架構就緒 |
| GitHub 整合 | gh CLI via Claude Code | ✅ E2E 驗證 |
| 工程部門 | /issue-plan + /issue-action + /pr-review | ✅ E2E 驗證 |

### 待建

| 能力 | 需要什麼 | 複雜度 |
|------|---------|--------|
| 內容部門 | blog-writer skill + Ghost/Hashnode API | 低（1-2 天） |
| 社群部門 | issue-responder skill + webhook 擴展 | 低（觸發機制已有） |
| 分析部門 | data-analyst skill + analytics API | 中 |
| 商務部門 | landing-page skill + Stripe API | 中 |
| 手機 cockpit | React Native app (karvi#1) | 高（獨立專案） |
| 對外發布 | Blog/X API 接入 | 低 |

### Phase 路線圖對照

```
Phase 0: 定義 + 手動驗證        ✅ 完成（工程部 E2E 通過）
Phase 1: Content Dept 上線      → 下一步
Phase 2: Community Dept 上線    → 觸發機制已有，差 skill 定義
Phase 3: Analytics + Feedback   → 待啟動
Phase 4: Revenue               → 待啟動
```

## 8. 下一步候選

以下按「解鎖價值 / 工作量」排序：

### A. Content Dept 上線（Phase 1 — 高價值/低工作量）

需要：
1. 一個 `blog-writer` skill（參考 `/issue-plan` 結構）
2. Ghost 或 Hashnode Content API 接入（一個 POST endpoint）
3. Karvi task type 擴展：`content` 除了 `engineering`

產出：第一篇 AI 自主撰寫 + 發布的 blog post。
這是 Grith 的 **launch moment**。

### B. 加入 human gate（低工作量）

在 plan → implement 之間加一個 `human_review` 判斷：
- route-engine 在 plan succeeded 後 check board controls
- `auto_implement: true` → 直接進 implement
- `auto_implement: false` → 暫停，push notification，等人 approve

好處：更安全的 production 模式。

### C. Review → Fix 循環（中工作量）

route-engine 在 review step 判斷「有 blocker」時：
- 插入 `fix` step（讀 review comment → 改 code → push）
- fix done → 再跑一次 review
- 最多 N 次，超過 → human_review

好處：pipeline 能自我修正，減少人工介入。

### D. Merge step（低工作量）

在 review succeeded 後自動 `gh pr merge --squash`。
需要 GitHub token 有 write 權限。

### E. Unix/Cloud 部署（中工作量）

把 Karvi server 部署到 cloud（fly.io 已有 Dockerfile）。
需要驗證 Unix 路線 + 安裝 Claude CLI on server。

---

## 附錄：檔案清單

| 檔案 | 角色 |
|------|------|
| `server/runtime-claude.js` | Claude CLI adapter：spawn、JSON parse、完成偵測、tree kill |
| `server/step-worker.js` | Step 執行層：build message、acquire lock、dispatch、parse output、transition state |
| `server/step-schema.js` | Step 狀態機：create、transition、retry、idempotency |
| `server/kernel.js` | 決策層：route-engine → next_step / done / retry / human_review |
| `server/context-compiler.js` | Envelope builder：組裝 step 的 input（task info, retry context, refs） |
| `server/route-engine.js` | 路由引擎：根據 step output 決定下一步動作 |
| `server/management.js` | Board 管理：task CRUD、step pipeline 生成、budget、model hints |
| `server/integration-github.js` | GitHub webhook 處理：issue → task |
| `server/server.js` | 入口：runtime 載入、deps wiring、auto-dispatch loop |
