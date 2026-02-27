# Mobile Judgment Slot v0 收斂規格

> 日期：2026-02-27
> 範圍：task-engine 手機端（不含手機 runtime）
> 來源：A/B/C/D 研究軍團整合

---

## 1) 一句話定位（共識）

這不是手機版 task board。  
這是 **Human Judgment Slot**：讓人類在低注意力成本下，對代理群體注入高槓桿判斷。

---

## 2) 本質決策（先釘死）

1. **手機不跑 runtime**：手機只做判斷注入；執行仍在主機 `task-engine + runtime-openclaw/codex`。
2. **手機不是工作台**：不做長編輯、複雜排程、跨多層依賴重排。
3. **先分歧，後收斂**：先讓多個 interpretation 並存，再由人做 commitment。
4. **語言替換**：禁用 approve/reject，改用採行/保留分歧/沉澱規則。
5. **安全優先**：高風險操作預設不上手機直接生效。

---

## 3) 手機互動最小閉環

`signal → interpretation → commitment → propagation → (effect) → rule`

- **signal**：發生了什麼（事實）
- **interpretation**：怎麼解讀（可多個、可分歧）
- **commitment**：人類選定暫時方向（一次性/本輪/常態）
- **propagation**：判斷擴散到哪些 agent/task 類型
- **rule**：效果驗證後沉澱為長期規則

---

## 4) 注意力切片（手機行為模型）

| 切片 | 時長 | 可做 | 不做 |
|---|---:|---|---|
| Quick glance | 10 秒 | 收訖、延後、低風險放行 | 任何不可逆操作 |
| Thumb decision | 30 秒 | 二選一、短句 unblock、本輪優先級 | 複雜依賴推理 |
| Short focus | 2 分鐘 | 單一脈絡中風險判斷 | 架構級改動、長文規劃 |

日容量建議：高品質判斷 8–12 次/日；超額後進入「只收不打擾」。

---

## 5) 通知策略（A/B/C 三層）

## A 類（立即喚醒）
- 分歧裁決（互斥 interpretation）
- 不可逆決策（高衝擊生效）
- 高風險阻塞（有時效 + 外溢）

## B 類（合併摘要）
- 趨勢退化但未臨界
- 重複中低風險異常

## C 類（不推播）
- 一般狀態更新
- 可自動修復的低風險事件

### 節流基線（v0）
- dedup key：`category:primaryRef:decisionType:rootCauseHash`
- 合併窗：3 分鐘
- 冷卻：P1=20 分、P2=60 分
- 24h 上限：8 則主動喚醒
- judgment slot lock：同時只開 1 個待決策通知

---

## 6) 安全分級（手機操作邊界）

| 等級 | 定義 | 手機可做 |
|---|---|---|
| S0 即時 | 低衝擊、可局部修正 | 可直接生效 |
| S1 需確認 | 中衝擊、可回滾 | 二次確認 + Undo window |
| S2 桌面限定 | 高衝擊、全域性或不可逆 | 手機僅能建 draft，不可直接 apply |

### S2 典型操作（手機禁直接生效）
- 全域 lesson/policy 生效/覆蓋
- 大幅 controls 調整
- 批量治理或批量狀態操作

---

## 7) v0 資料與 API 收斂

## 7.1 board.json（增量）
在既有 `signals/insights/lessons` 之上新增：

```json
{
  "commitments": []
}
```

語義映射：
- interpretation ≈ insights
- rule ≈ lessons
- commitment = 新增中介層（本次 v0 核心）

## 7.2 新增 API（最小集）
- `POST /api/commitments`：建立 commitment（必填 scope + targets）
- `POST /api/commitments/:id/diffuse`：擴散目標
- `POST /api/commitments/:id/revoke`：撤回承諾
- `POST /api/interpretations/:id/diverge`（可選）

scope 結構：

```json
{
  "mode": "once|round|permanent",
  "roundId": "optional",
  "consumeLimit": 1,
  "expiresAt": "optional"
}
```

---

## 8) 手機 UI（v0）只做三個核心畫面

1. **Need Judgment（需要你判斷）**
   - 只顯示 A 類事件
   - 每張卡必有：你要決定什麼、影響面、截止、預設動作

2. **Interpretations（解讀並列）**
   - 同一 signal 下多觀點並列
   - 支援「保留分歧」

3. **Commitment Sheet（採行面板）**
   - 選 scope（一次/本輪/常態）
   - 選 targets（擴散對象）
   - 顯示可逆性與風險等級

---

## 9) 兩週落地計畫（可開工）

## Week 1（核心結構）
1. `management.js/server.js` 加入 commitments schema + API。
2. 寫 `notify-evaluator`（可先做 script）實作 N01~N10 規則。
3. 寫入 append-only audit 事件（commitment/rule/controls 變更）。
4. 做 S0/S1/S2 gate（先 hardcode 規則）。

## Week 2（手機體驗）
1. 手機 web UI（三畫面 + action sheet）。
2. 推播模板（A/B）與 10 秒最小欄位落地。
3. Undo window + 版本檢查（stale 防護）。
4. 儀表：通知量、決策延遲、反悔率、blocker 解鎖時間。

---

## 10) 驗收指標（v0）

1. **打擾效率**：推播總量下降，但 A 類事件處理時效提升。
2. **判斷品質**：手機決策後反悔率下降。
3. **流程效率**：`blocked` 平均解除時間縮短。
4. **治理安全**：S2 手機越權 0 次；所有高風險操作有 audit + rollback。

---

## 11) 明確不做（v0 out of scope）

- 手機端直接跑 agent runtime
- 手機端完整 task 編排/長文編輯
- 手機端全域 policy 直接生效
- 手機端作為主治理後台

---

## 12) 最終結論

v0 的成敗不在 UI 漂亮度，而在三件事：
1. **只叫醒該叫醒的人類判斷**（通知節制）
2. **讓判斷可擴散、可撤回、可追溯**（commitment + audit）
3. **把高風險治理留在桌面**（分級安全）

做到這三點，手機端就會是「協作加速器」，不是「小螢幕 SaaS」。
