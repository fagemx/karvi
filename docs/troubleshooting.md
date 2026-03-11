# Karvi 疑難排解指南

## 快速診斷

### 環境檢查
```bash
curl -s http://localhost:3461/api/health/preflight
```

### 版本確認
```bash
node -v    # 需要 >= 22
git --version
gh --version
```

---

## 啟動問題

### 症狀：EADDRINUSE: address already in use :::3461

**原因**: Port 3461 被其他 process 佔用

**診斷**:
```bash
# Windows (Git Bash)
netstat //ano | grep :3461

# Linux/macOS
lsof -i :3461
```

**解法**:
```bash
# 解法 A: 用不同 port
PORT=3462 npm start

# 解法 B: 殺掉佔用的 process
# Windows (Git Bash)
taskkill //F //PID <pid-from-netstat>
```

---

### 症狀：Server 啟動但 dispatch 失敗

**原因**: 沒有安裝任何 agent runtime CLI

**診斷**:
```bash
# 檢查已註冊的 runtimes
curl -s http://localhost:3461/api/runtimes
```

**解法**: 安裝至少一個 agent CLI：
```bash
# 選項 A: opencode (GLM/T8Star)
# 從 https://github.com/opencode-ai/opencode 安裝

# 選項 B: claude (Anthropic)
npm install -g @anthropic-ai/claude-code

# 選項 C: codex (OpenAI)
npm install -g @openai/codex
```

---

### 症狀：gh: command not found

**原因**: 未安裝 GitHub CLI

**診斷**:
```bash
gh --version
```

**解法**: 安裝 GitHub CLI
```bash
# Windows
winget install GitHub.cli

# macOS
brew install gh

# Linux
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md
```

---

### 症狀：Node.js 版本過舊

**原因**: Node.js < v22

**診斷**:
```bash
node -v
```

**解法**: 升級 Node.js 到 v22+
```bash
# 使用 nvm
nvm install 22
nvm use 22
```

---

## Dispatch 問題

### 症狀：Task 卡在 dispatched 不動

**原因**: Agent CLI 無法啟動（不在 PATH 或 spawn 失敗）

**診斷**:
```bash
# 檢查 runtime 是否可執行
which opencode || which claude || which codex

# 檢查 preflight 狀態
curl -s http://localhost:3461/api/health/preflight | jq '.checks.runtimes'
```

**解法**:
1. 確認 agent CLI 在 PATH 中
2. 重新開啟 terminal（可能需要 reload PATH）
3. 查看 server console 的錯誤訊息

---

### 症狀：Task 直接進入 blocked 狀態

**原因**: 有未滿足的 depends 依賴

**診斷**:
```bash
# 查看任務依賴
curl -s http://localhost:3461/api/board | jq '.taskPlan.tasks[] | {id, status, depends}'
```

**解法**: 等待依賴任務完成（status 變成 approved）

---

### 症狀：worktree already exists 錯誤

**原因**: 上次 dispatch 沒正常清理

**診斷**:
```bash
# 列出現有 worktrees
git worktree list

# 檢查 worktree 目錄
ls .claude/worktrees/
```

**解法**:
```bash
# 手動清理 worktree
git worktree remove .claude/worktrees/<task-id> --force

# 或刪除目錄
rm -rf .claude/worktrees/<task-id>

# 清理 stale references
git worktree prune
```

---

### 症狀：Agent 報 permission error / git 認證問題

**原因**: gh auth 或 git credential 未設定

**診斷**:
```bash
gh auth status
git remote -v
```

**解法**:
```bash
# 重新登入 GitHub CLI
gh auth login

# 設定 git credential
git config --global credential.helper manager
```

---

## API 問題

### 症狀：401 Unauthorized

**原因**: KARVI_API_TOKEN 已設但 request 沒帶

**診斷**:
```bash
# 檢查 server 的 token 狀態
curl -s http://localhost:3461/api/health/preflight | jq '.checks.env.KARVI_API_TOKEN'
```

**解法**: 在 request 加上 Authorization header
```bash
curl -H "Authorization: Bearer $KARVI_API_TOKEN" http://localhost:3461/api/board
```

---

### 症狀：503 Vault disabled

**原因**: 未設定 KARVI_VAULT_KEY

**診斷**:
```bash
curl -s http://localhost:3461/api/health/preflight | jq '.checks.env.KARVI_VAULT_KEY'
```

**解法**:
```bash
# 設定 vault key (64-char hex = 32 bytes)
export KARVI_VAULT_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# 或跳過 vault 功能（不使用 secrets API）
```

---

### 症狀：常見 HTTP 錯誤碼

| 狀態碼 | 意義 | 解法 |
|--------|------|------|
| 400 | Request 格式錯誤 | 檢查 JSON payload |
| 401 | 未認證 | 加 Authorization header |
| 404 | Resource 不存在 | 檢查 task ID / URL |
| 409 | 狀態衝突 | 檢查 task 當前狀態 |
| 500 | Server 內部錯誤 | 查看 server console log |
| 503 | 功能未啟用 | 設定相關環境變數 |

---

## 跨專案 Dispatch 問題

### 症狀：Worktree 建在錯誤目錄

**原因**: target_repo 路徑不正確

**診斷**:
```bash
# 檢查 task 的 target_repo
curl -s http://localhost:3461/api/board | jq '.taskPlan.tasks[] | {id, target_repo}'
```

**解法**: 確認目標路徑存在且是 git repo
```bash
# 檢查目標 repo
ls -la /path/to/target/repo/.git

# 使用絕對路徑
npm run go -- 42 --repo "C:\absolute\path\to\repo"
```

---

### 症狀：Agent 找不到 skill

**原因**: Skill 路徑在來源 repo 而非目標

**診斷**:
```bash
# 檢查目標 repo 的 skills
ls /path/to/target/repo/.claude/skills/
```

**解法**: 在目標 repo 建立 .claude/skills/
```bash
# 複製 skills 從 karvi
cp -r C:\ai_agent\karvi\.claude\skills\issue-plan /path/to/target/repo/.claude/skills/
cp -r C:\ai_agent\karvi\.claude\skills\issue-action /path/to/target/repo/.claude/skills/
cp -r C:\ai_agent\karvi\.claude\skills\pr-review /path/to/target/repo/.claude/skills/
```

---

## FAQ

### Q: 測試失敗 EADDRINUSE: :::13461

這不是你的 code 問題，是上一輪測試沒清乾淨。

```bash
# 找佔 port 的 process
netstat //ano | grep :13461

# 殺特定 PID
taskkill //F //PID <pid>
```

### Q: Task 狀態無法轉換

檢查允許的狀態轉換（見 server/management.js:360）:
- pending → dispatched
- dispatched → in_progress, blocked, cancelled
- in_progress → completed, needs_revision, blocked, cancelled
- completed → reviewing
- reviewing → approved, needs_revision
- needs_revision → in_progress, approved
- approved → (terminal)
- cancelled → (terminal)

### Q: Board 資料消失

如果使用了覆蓋式 API 呼叫（已在 GH-250 修復），請更新到最新版本。

---

## 相關文件

- [Getting Started Guide](getting-started.md) — 正向流程
- [Cross-Project Dispatch](cross-project-dispatch.md) — 跨專案設定
- [Self-Hosting Guide](self-hosting.md) — 遠端存取
