# Karvi — Agent Instructions

> 這份文件會自動注入到所有 agent session（opencode / claude）的 system prompt。

## 環境資訊

- **OS**: Windows 11, shell 是 bash（Git Bash）
- **Node.js**: v22+
- **專案根目錄**: 由 worktree 決定，可能是 `.claude/worktrees/GH-XXX/`
- **Server**: 主 server 跑在 port 3461，測試 server 跑在 port 13461
- **Repo**: github.com/fagemx/karvi

## 絕對禁止的行為

### 1. 永遠不要丟棄自己的工作

```
❌ git reset HEAD~1
❌ git checkout .
❌ git checkout -- <file>
❌ git restore .
❌ git clean -fd
```

如果你已經 commit 了，**絕對不要 undo**。如果 test 失敗，先診斷原因，修 code 再 commit，不要 revert。

### 2. 永遠不要殺 node.exe

```
❌ taskkill //F //IM node.exe
❌ Stop-Process -Name node
❌ killall node
```

這會殺掉主 server 和你自己的 process。如果 port 被佔，找具體 PID 再殺。

### 3. 不要加外部依賴

```
❌ npm install <anything>
```

Karvi 是零外部依賴專案，只用 Node.js 內建模組。

## Windows Bash 指令慣例

在 Git Bash 下，Windows 指令的 `/` flag 要用 `//`：

```bash
# 正確
taskkill //F //PID 12345
netstat //ano | grep :3461

# 錯誤 — bash 會把 /F 當成路徑
taskkill /F /PID 12345
```

spawn 子進程用 `cmd.exe /d /s /c` pattern：
```javascript
spawn('cmd.exe', ['/d', '/s', '/c', actualCommand], { ... })
```

## 測試指引

### `npm test` (port 13461)

`npm test` 會啟動測試 server 在 port 13461。如果遇到：

```
Error: listen EADDRINUSE: address already in use :::13461
```

**這不是你的 code 問題。** 這表示上一輪測試沒清乾淨，或主 server 佔著 port。

處理方式：
```bash
# 找佔 port 的 process
netstat //ano | grep ":13461"
# 殺特定 PID（不是殺全部 node）
taskkill //F //PID <specific-pid>
# 再跑一次
npm test
```

### 單檔語法檢查

修改任何 `.js` 檔後，一定要跑：
```bash
node -c <file>
```

### 單元測試

可以單獨跑個別測試檔，不需要 `npm test`：
```bash
node server/test-step-schema.js
node server/test-context-compiler.js
```

## Git 工作流程

- 你在 worktree 的獨立分支上工作（`agent/GH-XXX`）
- commit 訊息格式：`feat(scope): description (GH-XXX)`
- commit 後不要 revert — 如果需要修正，做新的 commit
- 做完所有修改後 push branch：`git push origin agent/GH-XXX`

## 程式碼慣例

- board.json 是 single source of truth — agent 不直接寫 board.json
- 原子寫入：先寫 `.tmp` 再 rename
- 中文優先的文件和註釋
- 遵循既有 code pattern，不要發明新的
- 所有 export 放在檔案底部的 `module.exports`

## Step Pipeline

你正在執行 step pipeline 中的一個 step。完成時必須輸出：

```
STEP_RESULT:{"status":"succeeded","summary":"what you did"}
```

失敗時：
```
STEP_RESULT:{"status":"failed","error":"what went wrong","failure_mode":"TEST_FAILURE","retryable":true}
```

**不要在中途輸出 STEP_RESULT** — 只在最後一行輸出。
