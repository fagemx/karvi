# S7: Codex Runtime + Skill 共用層

## 目標

在 S5（中立 dispatch plan）和 S6（原子 API）的基礎上：

1. 建立 `runtime-codex.js` — 吃同一套 dispatch plan，呼叫 `codex exec`
2. 統一 Skill 來源 — canonical path + symlink，OpenClaw 和 Codex 共用
3. 定義 Agent Roles — Codex config.toml 的 `[agents.*]` 設定
4. 擴充 management.js — dispatch plan 帶上 `requiredSkills` 和 `codexRole`
5. server.js 加 runtime 選擇器 — 根據 `plan.runtimeHint` 分流

**完成後：同一個 board 上的任務可以混用 OpenClaw 和 Codex 執行。**

---

## 前置條件

- [x] S1-S4: 拆層完成
- [x] S5: dispatchable state + buildDispatchPlan
- [x] S6: 原子 API
- [ ] Codex CLI 已安裝（`codex --version` ≥ 0.104.0）

---

## 設計原則

1. **management.js 不知道 runtime 細節**
   - 只輸出 `runtimeHint`、`requiredSkills`、`codexRole`
   - 不引入 Codex CLI 參數

2. **runtime-codex.js 和 runtime-openclaw.js 介面對齊**
   - 都暴露 `dispatch(plan)` → Promise
   - 都暴露 `capabilities()` → 物件

3. **server.js 只做路由，不做 runtime 判斷邏輯**
   - `getRuntime(hint)` 回傳對應 adapter
   - 派發流程不管底層是什麼

4. **Skill 單一來源**
   - `~/.agents/skills/` 為 canonical（agentskills.io 標準路徑）
   - symlink 讓兩個平台讀到同一份

---

## Part 1: Skill 共用

### 1.1 目錄結構

```
~/.agents/skills/                        ← canonical（Codex USER scope 自動掃描）
  ├── conversapix-storyboard/SKILL.md
  ├── gctx-workflow/SKILL.md
  ├── coding-agent/SKILL.md
  └── session-handoff/SKILL.md

~/.openclaw/workspace/skills/            ← symlink 指向 canonical
  ├── conversapix-storyboard → ~/.agents/skills/conversapix-storyboard
  ├── gctx-workflow          → ~/.agents/skills/gctx-workflow
  ├── coding-agent           → ~/.agents/skills/coding-agent
  └── session-handoff        → ~/.agents/skills/session-handoff
```

### 1.2 遷移步驟（一次性）

```powershell
# 1. 建 canonical 位置
mkdir "$HOME\.agents\skills"

# 2. 搬移（以 conversapix-storyboard 為例，對每個 skill 重複）
Move-Item "$HOME\.openclaw\workspace\skills\conversapix-storyboard" "$HOME\.agents\skills\"

# 3. 建 symlink（需要管理員權限或開發者模式）
New-Item -ItemType SymbolicLink `
  -Path "$HOME\.openclaw\workspace\skills\conversapix-storyboard" `
  -Target "$HOME\.agents\skills\conversapix-storyboard"
```

### 1.3 驗證

```powershell
# Codex 能看到
codex --version   # 確認能啟動
# 進入 codex 後 /skills 應該列出共用 skills

# OpenClaw 能看到
ls ~/.openclaw/workspace/skills/
# symlink 都指向正確位置
```

### 1.4 格式相容性

兩個平台都遵循 agentskills.io SKILL.md 標準：

```yaml
---
name: skill-name
description: "when to use this skill"
---
# Instructions...
```

不需要改 SKILL.md 內容。唯一差異：
- Codex 支援 `agents/openai.yaml`（UI metadata，可選）
- OpenClaw 支援 `metadata.clawdbot`（OpenClaw 專用，可選）

**兩者可以共存在同一個 SKILL.md frontmatter 裡，互不干擾。**

---

## Part 2: Codex Agent Roles

### 2.1 config.toml 設定

在 `~/.codex/config.toml` 新增：

```toml
[features]
multi_agent = true

[agents]
max_threads = 4
max_depth = 2

[agents.worker]
description = "執行具體程式碼任務，專注完成不發問"
config_file = "agents/worker.toml"

[agents.designer]
description = "視覺設計專家，負責分鏡圖和圖片生成"
config_file = "agents/designer.toml"

[agents.reviewer]
description = "程式碼審查，唯讀模式"
config_file = "agents/reviewer.toml"
```

### 2.2 Role TOML 檔案

建立 `~/.codex/agents/` 目錄：

**`~/.codex/agents/worker.toml`**

```toml
model = "gpt-5.3-codex"
model_reasoning_effort = "high"
developer_instructions = """
你是一個執行者。收到任務後直接做，做完回報。
最後一行必須輸出結構化結果：
TASK_RESULT: {"status":"completed","summary":"..."}
不要問問題。不要解釋推理過程。直接做。
"""
```

**`~/.codex/agents/designer.toml`**

```toml
model = "gpt-5.3-codex"
model_reasoning_effort = "high"
developer_instructions = """
你是視覺設計師。只使用以下 skill：
- $conversapix-storyboard

不要寫程式碼。不要改 config 檔。
完成後回報結構化結果：
TASK_RESULT: {"status":"completed","summary":"...","artifacts":["path/to/image"]}
"""
```

**`~/.codex/agents/reviewer.toml`**

```toml
model = "gpt-5.3-codex"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
你是審查者。審查程式碼品質，輸出結構化結果。
最後一行必須輸出：
REVIEW_RESULT: {"pass":true/false,"score":0-100,"issues":[...]}
"""
```

### 2.3 Role ↔ Skill 對照

| Role | 可用 Skills | sandbox |
|------|------------|---------|
| `worker` | coding-agent, gctx-workflow | workspace-write |
| `designer` | conversapix-storyboard | workspace-write |
| `reviewer` | （不限，但 read-only） | read-only |

> 注意：Codex 沒有原生 skill 白名單機制。控制方式是透過 `developer_instructions` 中的明確指引 + `sandbox_mode` 限制寫入範圍。

---

## Part 3: runtime-codex.js

### 3.1 檔案位置

`project/task-engine/runtime-codex.js`

### 3.2 實作

```javascript
const { spawn } = require('child_process');
const path = require('path');

const DIR = __dirname;
const CODEX_CMD = process.env.CODEX_CMD || 'codex';

function dispatch(plan) {
  return new Promise((resolve, reject) => {
    const args = ['exec', '--full-auto', '--json'];

    if (plan.modelHint) args.push('-m', plan.modelHint);

    const workDir = plan.workingDir || path.resolve(DIR, '..', '..');
    args.push('-C', workDir);

    if (plan.codexRole) {
      args.push('-c', `agents.default.config_file=agents/${plan.codexRole}.toml`);
    }

    args.push('--', plan.message);

    const child = spawn(CODEX_CMD, args, {
      cwd: workDir,
      windowsHide: true,
      shell: false,
      timeout: (plan.timeoutSec || 180) * 1000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => (stdout += c));
    child.stderr.on('data', c => (stderr += c));

    child.on('error', err => reject(err));
    child.on('close', code => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `codex exited ${code}`));
      }

      let lastMessage = null;
      for (const line of stdout.trim().split('\n')) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'message' || ev.message) lastMessage = ev;
        } catch {}
      }

      resolve({
        code,
        stdout,
        stderr,
        parsed: lastMessage,
        sessionId: lastMessage?.session_id || null,
      });
    });
  });
}

function extractReplyText(parsed, stdout) {
  if (parsed?.message) return parsed.message;
  if (parsed?.content) return parsed.content;

  const lines = (stdout || '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (ev.message || ev.content) return ev.message || ev.content;
    } catch {}
  }
  return stdout?.slice(-2000) || '';
}

function extractSessionId(parsed) {
  return parsed?.session_id || null;
}

function capabilities() {
  return {
    runtime: 'codex',
    supportsReview: false,
    supportsSessionResume: true,
    supportsRoles: true,
    supportsMultiAgent: true,
  };
}

module.exports = { dispatch, extractReplyText, extractSessionId, capabilities };
```

### 3.3 介面對齊驗證

| 方法 | runtime-openclaw.js | runtime-codex.js |
|------|-------------------|-----------------|
| `dispatch(plan)` | ✓ | ✓ |
| `extractReplyText(parsed, stdout)` | ✓ | ✓ |
| `extractSessionId(parsed)` | ✓ | ✓ |
| `capabilities()` | ✓ | ✓ |
| `spawnReview(...)` | ✓ | ✗（不需要，review 走統一流程） |

---

## Part 4: management.js 擴充

### 4.1 新增 Skill ↔ Role 映射

在常數區新增：

```javascript
const SKILL_ROLE_MAP = {
  'conversapix-storyboard': { codexRole: 'designer', skills: ['conversapix-storyboard'] },
  'coding-agent':           { codexRole: 'worker',   skills: ['coding-agent', 'gctx-workflow'] },
  'gctx-workflow':          { codexRole: 'worker',   skills: ['gctx-workflow'] },
};

const DEFAULT_CODEX_ROLE = 'worker';
```

### 4.2 擴充 buildDispatchPlan

在現有 `buildDispatchPlan` 中加入 skill/role 資訊：

```javascript
function buildDispatchPlan(board, task, options = {}) {
  // ... 現有邏輯 ...

  const runtimeHint = options.runtimeHint
    || board.controls?.preferred_runtime
    || 'openclaw';

  // Skill / Role 推導
  const taskSkill = task.skill || null;
  const profile = (taskSkill && SKILL_ROLE_MAP[taskSkill]) || null;

  return {
    // ... 現有欄位 ...
    runtimeHint,
    requiredSkills: profile?.skills || (taskSkill ? [taskSkill] : []),
    codexRole: profile?.codexRole || DEFAULT_CODEX_ROLE,
  };
}
```

### 4.3 exports 新增

```javascript
SKILL_ROLE_MAP,
DEFAULT_CODEX_ROLE,
```

---

## Part 5: server.js Runtime 選擇器

### 5.1 新增 runtime 載入

在 server.js 頂部：

```javascript
const runtimeOpenClaw = require('./runtime-openclaw');

let runtimeCodex = null;
try {
  runtimeCodex = require('./runtime-codex');
} catch { /* codex not installed, skip */ }

const RUNTIMES = {
  openclaw: runtimeOpenClaw,
  ...(runtimeCodex ? { codex: runtimeCodex } : {}),
};

function getRuntime(hint) {
  return RUNTIMES[hint] || runtimeOpenClaw;
}
```

### 5.2 改現有 runtime 呼叫點

把原本直接呼叫 `runtime.runOpenclawTurn(...)` 的地方改成：

```javascript
const rt = getRuntime(plan.runtimeHint);
rt.dispatch(plan).then(result => {
  // ...
  task.dispatch.sessionId = rt.extractSessionId(result.parsed) || null;
  const replyText = rt.extractReplyText(result.parsed, result.stdout);
  // ...
});
```

### 5.3 API 路由不用改

`/api/dispatch-next` 和 `/api/project` 已經透過 `plan.runtimeHint` 做分流，不需要增加新路由。

---

## 格式塔：方法 A ↔ 方法 B 並存

同一個 board 上可以混用：

```json
{
  "taskPlan": {
    "tasks": [
      {
        "id": "T1", "title": "寫腳本",
        "dispatch": { "runtime": "openclaw", "state": "completed" }
      },
      {
        "id": "T2", "title": "生成分鏡",
        "dispatch": { "runtime": "codex", "codexRole": "designer", "state": "dispatching" }
      },
      {
        "id": "T3", "title": "整合影片",
        "dispatch": { "runtime": "codex", "state": "prepared" }
      }
    ]
  }
}
```

管理層的進化觀測粒度取決於 runtime 回傳的資訊量：
- **OpenClaw**：每一輪都有 reply，signal 粒度細
- **Codex（方法 A）**：每個 task 一次 result，signal 粒度適中
- **Codex（方法 B，multi-agent）**：整批完成後一次 result，signal 粒度粗

三者都會產生 signal → insight → lesson，只是學習速度不同。

---

## 驗證

### 1. Skill 共用

```powershell
# canonical 存在
Test-Path "$HOME\.agents\skills\conversapix-storyboard\SKILL.md"

# OpenClaw symlink 正確
(Get-Item "$HOME\.openclaw\workspace\skills\conversapix-storyboard").Target

# Codex 能列出
codex  # 進入後 /skills
```

### 2. runtime-codex.js 語法

```bash
node -c runtime-codex.js
node -e "const r=require('./runtime-codex'); console.log(r.capabilities())"
```

### 3. Runtime 選擇器

```bash
# 啟動 server
node server.js

# 用 codex runtime 派發（需要 board 裡有任務且 controls.preferred_runtime = 'codex'）
curl -X POST http://localhost:3461/api/dispatch-next
```

### 4. 既有測試不壞

```bash
node ../../smoke-test.js 3461
node test-evolution-loop.js
```

---

## 不要做的事

- 不要改 SKILL.md 內容（只搬位置、建 symlink）
- 不要在 management.js 引入 `child_process`
- 不要讓 runtime-codex.js 直接寫 board.json
- 不要硬編碼 Codex CLI 路徑（用 `CODEX_CMD` 環境變數）
- 不要刪除 runtime-openclaw.js 的舊 API（`runOpenclawTurn` 等保留）
- 不要假設 Codex 一定已安裝（`try/catch` 載入）

---

## 完成標記

更新 `00_OVERVIEW.md` Progress Tracker：

```
[x] S7: Codex Runtime + Skill 共用層
```
