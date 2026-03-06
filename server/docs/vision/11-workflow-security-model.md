# 11 — Workflow 安全模型：代理操控的深度防禦

> 2026-03-06 討論記錄

## 問題

Vision 10 把 step 定義從 code 提升到文件（workflow），讓 AI 能自由組裝 pipeline。但這帶來安全問題：

**越軟越容易被操控。**

Skill 現在就有這個問題 — 任何人能寫 SKILL.md，agent 無條件信任內容，沒有審核、沒有簽章、沒有分級。Workflow 文件化會讓攻擊面更大。

## 攻擊面分析

### 五層攻擊面

```
Layer 1: Skill 被篡改
  → 改了 pr-review/SKILL.md
  → review 永遠說 LGTM → 壞 code 直接進 main

Layer 2: Workflow 被篡改
  → 刪掉 review step、移除 human gate
  → pipeline 從 plan → implement → review
  → 變成 plan → implement → 直接 merge

Layer 3: AI 自己寫惡意 workflow
  → AI 被 prompt injection → 寫了跳過安全檢查的 workflow
  → kernel 照文件執行 → 沒有人類介入點

Layer 4: 跨 repo 信任
  → dispatch 到 target repo → 讀 target repo 的 skills/workflows
  → target repo 被植入惡意指令 → agent 在那邊執行

Layer 5: 供應鏈
  → 「通用 skill」從一個地方複製到多個 repo
  → 源頭被汙染 → 所有 repo 受影響
```

### 核心矛盾

```
我們想要：AI 能自由組裝 pipeline（軟）
但也要：不能被操控跳過安全檢查（硬）

軟 = 靈活 = 容易被改
硬 = 安全 = 不能被改
```

這不是二選一，是分層處理。

## 解法：四層深度防禦

### Layer 0: Kernel 硬規則（不可覆寫）

不管 workflow 怎麼寫，kernel 有些規則是硬編碼的，文件覆寫不了：

```
Kernel 硬規則（寫在 code 裡，不在文件裡）：
  1. 成本上限 → 超過就停，workflow 說「繼續」也沒用
  2. worktree 隔離 → agent 不能跳出自己的目錄
  3. 敏感操作需人類確認 → merge、deploy、刪除 永遠有 gate
  4. audit log 不可關閉 → 每個 step 的 input/output 一定記錄
  5. agent 不能改自己正在執行的 workflow → 防自我修改
```

這些是 OS 層級的保護 — 不管 userspace 程式怎麼寫，kernel 保證邊界。

```
類比：
  Linux kernel 不讓 process 讀其他 process 的記憶體
  不管程式怎麼寫，syscall 層面就擋住了

  Karvi kernel 不讓 agent 跳過 merge gate
  不管 workflow 怎麼寫，kernel 執行時強制加回來
```

### Layer 1: Workflow 信任分級（frozen / approved / dynamic）

不是所有 workflow 都有同等權限：

```
Tier 1: frozen（人類審核過的）
  - 由人明確批准
  - 標記為 frozen → AI 不能修改
  - 例：execution.md（標準 plan → implement → review）
  - 享有完整權限（可以 dispatch、可以觸發 merge）

Tier 2: approved（AI 生成但人確認過的）
  - AI 寫的，人看過說 OK
  - 可以執行，但有額外限制
  - 例：planning.md（AI 建議的規劃流程，人確認了）

Tier 3: dynamic（AI 即時生成的）
  - AI 根據意圖臨時組裝
  - 最多限制：不能移除 gate、不能改權限、不能 dispatch 到其他 repo
  - 例：AI 判斷「這個只需要 research」→ 臨時建一個單 step workflow
```

```yaml
# execution.md
name: 執行 pipeline
trust: frozen              # ← 人類審核過，AI 不能改
frozen_by: user
frozen_at: 2026-03-06

steps:
  - id: review
    gate: human_approval   # ← 就算 AI 改了這個文件把 gate 拿掉
                           #    kernel 看到 trust:frozen 被改動
                           #    → 拒絕執行 → 要求人重新審核
```

### Layer 2: 操作白名單（每種 workflow 的權限邊界）

```
execution workflow 的 agent 能做：
  ✅ 讀寫 worktree 內的檔案
  ✅ 跑測試
  ✅ git commit/push
  ✅ 建 PR
  ❌ merge PR（需要 gate）
  ❌ 刪 branch
  ❌ 改 workflow/skill 文件
  ❌ 存取其他 worktree

planning workflow 的 agent 能做：
  ✅ 讀 codebase
  ✅ 寫設計文件
  ✅ 建 GitHub issues
  ❌ 寫 code
  ❌ commit
  ❌ 改 workflow/skill 文件
```

不管 skill 怎麼指示 agent，kernel 層面的權限擋住。

類比：Linux capabilities（CAP_NET_ADMIN 等）— 程式只有被授予的能力。

### Layer 3: 變更偵測（hash + audit）

```
workflow-integrity.json（kernel 維護）：
{
  "execution.md": {
    "hash": "sha256:abc123",
    "trust": "frozen",
    "frozen_by": "user",
    "last_verified": "2026-03-06"
  },
  "planning.md": {
    "hash": "sha256:def456",
    "trust": "approved",
    "approved_by": "user",
    "last_verified": "2026-03-06"
  }
}

每次執行前：
  1. 算文件 hash
  2. 比對 integrity.json
  3. 不匹配 → 拒絕執行 + 通知用戶
```

Frozen workflow 被改 → 直接拒絕執行。Approved workflow 被改 → 降級為 dynamic，套用最嚴限制。

類比：tripwire / AIDE（入侵偵測）+ macOS code signing。

## Human Gate 不可移除

```
Kernel 硬規則：
  - 任何包含 merge/deploy/delete 動作的 step，
    自動加 human_approval gate
  - workflow 文件可以加更多 gate，但不能移除這些

就算 AI 寫了一個沒有 gate 的 workflow：
  kernel 執行時掃描 step 定義
    → 發現有 merge 動作
    → 自動插入 gate
    → 不管 workflow 怎麼寫
```

類比：sudo 密碼 — 不管腳本怎麼寫，特權操作一定要人確認。

## 跨 Repo Dispatch 的信任邊界

```
dispatch 到 target repo 時：
  1. 只帶 Karvi 的 frozen workflow（不用 target repo 的）
  2. Skill 可以讀 target repo 的（因為專案特定）
  3. 但 skill 的操作仍受 kernel 白名單限制
  4. Target repo 不能反向影響 Karvi 的 workflow

信任方向是單向的：
  Karvi → target repo（Karvi 信任自己的 workflow）
  target repo → Karvi（不信任，不讀 target 的 workflow）
```

## 完整安全架構總覽

```
Layer 0: Kernel 硬規則（code，不可覆寫）
  - 成本上限、隔離、強制 gate、audit log、防自我修改
  - 類比：OS kernel 的 syscall 層

Layer 1: Workflow 信任分級（frozen / approved / dynamic）
  - frozen 不可改，改了就拒絕
  - dynamic 有額外限制
  - 類比：code signing + 權限分級

Layer 2: 操作白名單（每種 workflow 能做什麼）
  - execution 能寫 code 不能改 workflow
  - planning 能寫 doc 不能寫 code
  - 類比：Linux capabilities

Layer 3: 變更偵測（hash + audit）
  - 文件被改就知道
  - 每個變更有 who/when/what
  - 類比：tripwire / AIDE
```

**人類閘門貫穿所有層 — 敏感操作永遠要人確認，不管前面怎麼繞。**

## Skill 現有安全問題

現狀（整個 Claude Code 生態的問題，不只是 Karvi）：

```
現在的 skill 安全性 = 零
  - 任何人能寫 SKILL.md
  - agent 無條件信任 skill 內容
  - skill 可以指示 agent 做任何事
  - 沒有審核機制、沒有簽章、沒有分級
```

Karvi 因為有 kernel，反而有機會在上面加安全層：

```
沒有 Kernel 的世界：
  skill 說什麼 → agent 做什麼 → 沒人管

有 Kernel 的世界：
  skill 說什麼 → agent 想做什麼 → kernel 檢查權限 → 允許或拒絕
```

## 剩餘風險（誠實評估）

```
1. 人類閘門疲勞
   → 每次都要確認 → 人開始無腦按 approve
   → 解法：閘門要少而精，不能每步都問

2. Skill 內容的語義檢查
   → kernel 能擋操作，但不能判斷 skill 的指令是否合理
   → 「寫測試時故意寫會過的假測試」→ 操作合法但意圖惡意
   → 解法：review step 本身就是防線，但 review skill 也能被汙染
   → 最終防線：人 review PR

3. AI 能力提升後的新攻擊面
   → 現在 AI 不夠聰明做複雜攻擊
   → 未來 AI 更強 → 可能找到繞過方式
   → 解法：kernel 硬規則要跟著 AI 能力演進
```

**沒有完美的安全，但有深度防禦。每一層擋一類攻擊，全部被突破的機率遠低於單層。**

## 跟其他 Vision 文件的關係

| 文件 | 關係 |
|------|------|
| 10-workflow-file-architecture.md | 本篇是 10 的安全對策 |
| 07-planning-automation.md | Human gate 在這裡首次定義 |
| 08-cross-repo-skills.md | 跨 repo 信任邊界在這裡擴展 |
| 03-agent-execution-kernel.md | Kernel 硬規則是 Layer 2 執行保證的延伸 |
| 06-ai-governs-ai-discussion.md | 信任是 kernel 的核心價值 — 本篇定義怎麼實現信任 |

## 一句話

**安全不靠 AI 自律，靠 kernel 硬規則 + workflow 分級 + 操作白名單 + 變更偵測。四層防禦，每層擋一類攻擊。越靠近 kernel 越硬，越靠近 AI 越軟 — 軟的地方給靈活性，硬的地方給安全性。**
