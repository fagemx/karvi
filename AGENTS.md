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

## 思考方法（所有 step 通用）

每個任務都用五階段流程處理。不要跳步驟。

1. **Understand** — 這個系統是什麼？它的目的、上下文、約束條件？讀 issue、讀 task description、讀相關 code。
2. **Frame** — 明確說出你的理解。這是什麼類型的問題？需要改哪些檔案？影響範圍多大？
3. **Analyze** — 在你的框架內做實際分析或實作。每個結論都指向具體證據（檔案路徑 + 行號）。
4. **Challenge** — 什麼會讓你的整個框架錯誤？你忽略了什麼？有沒有遺漏的需求？
5. **Conclude** — 你有信心的結論是什麼？什麼仍不確定？區分「確知」和「推測」。

### 證據紀律

- 每個判斷都指向具體證據：`server/kernel.js:311` 而非「某處有個問題」
- 區分：「我知道這個因為 [code 證據]」vs「我猜測這個因為 [模式]」
- 如果無法指向證據，標記為不確定或推測

## 任務執行方法論

### Plan Step

1. **Understand**: 用 `gh issue view <number>` 讀完整 issue。讀 task description。
2. **Frame**: 從 issue + task description 提取**所有具體需求**，列成編號清單。不要省略任何一項。
3. **Analyze**: 研究相關 codebase（讀檔、grep），理解現有模式。每個需求對應一個實作步驟。
4. **Challenge**: 回頭檢查需求清單 — 有沒有漏掉的？有沒有需求之間的衝突？
5. **Conclude**: 輸出具體的實作計畫。標記你確定的 vs 需要確認的。

### Implement Step

1. **Understand**: 讀取 plan step 的產出（issue comments 或 artifact）。理解每一項要做什麼。
2. **Frame**: 列出要改的檔案清單。評估影響範圍。
3. **Analyze**: **逐項實作** plan 中的每個步驟，不要跳過。
   - 每改完一個檔案，跑 `node -c <file>` 確認語法
   - 改完所有檔案後，跑相關測試確認不破壞既有功能
4. **Challenge**: 回頭對照需求清單 — 是否每一項都做到了？測試覆蓋了嗎？
5. **Conclude**: commit 並 push `git push -u origin <branch>`，建 PR `gh pr create`

### Review Step

1. **Understand**: 讀取 PR diff，理解改了什麼。
2. **Frame**: 這個 PR 的目標是什麼？對應哪個 issue？
3. **Analyze**: 四點檢查：Scope / Reality / Testing / YAGNI
4. **Challenge**: 是否所有 issue 需求都被實作了？有沒有隱藏的 bug？
5. **Conclude**: 判定 LGTM 或 Changes Requested，每個問題附具體 `file:line` 引用。

### 通用規則

- **Task description 是你的需求規格** — 裡面列的每一項都必須做到
- 如果 issue 和 task description 有矛盾，以 task description 為準
- 不確定的需求不要猜，做保守的實作然後在 PR 說明
