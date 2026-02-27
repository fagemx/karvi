# 手機端「人類判斷注入」失敗模式與防護欄（研究軍團 D）

> 日期：2026-02-27  
> 範圍：task-engine 的 mobile judgment slot（人類在手機上注入判斷），不等同完整任務審批台。

---

## 0) 前提與設計目標

依據現有 blackboard/tactical/operational 設計，手機端應優先支援：
- 快速寫入 `signal / insight`（短判斷）
- 對低風險建議做有限度決策
- 在高風險情境下「延遲決策而不失控」

手機端的核心限制：**螢幕小、上下文窄、誤觸率高、網路延遲與中斷常見**。  
因此 v0 必須把重點放在「避免錯誤生效」與「可追溯、可回滾」。

---

## 1) 失敗模式清單（Failure Modes）

## A. 誤判（Judgment Error）

1. **FM-A1：把局部訊號當全域結論**
   - 例：看到單次 review 低分就調整全系統 `quality_threshold`。
   - 風險：造成大範圍 false fail / 流程堵塞。

2. **FM-A2：將短期噪音誤認為長期模式**
   - 例：一次 blocked 就改 assignee policy。
   - 風險：策略震盪（policy thrashing）。

3. **FM-A3：風險等級估錯**
   - 例：把 high-risk controls 變更當 low-risk auto-apply。
   - 風險：高影響操作在無充分審查下生效。

## B. 誤觸（Touch/UI Error）

4. **FM-B1：單擊即生效導致誤操作**
   - 例：誤按「批准 proposal」或「狀態轉移」。
   - 風險：錯誤狀態被寫入黑板，後續自動流程連鎖觸發。

5. **FM-B2：相鄰危險按鈕誤觸**
   - 例：「Approve」與「Reject」或「Apply」距離過近。
   - 風險：不可預期的方向性錯誤。

6. **FM-B3：手勢操作缺乏可見回饋**
   - 例：滑動手勢觸發 commit，使用者未察覺。
   - 風險：無意識提交（silent commit）。

## C. 上下文不足（Context Deficit）

7. **FM-C1：資訊截斷造成錯誤決策**
   - 例：手機只顯示摘要，未見 evidence/歷史/依賴。
   - 風險：錯誤批准、錯誤否決。

8. **FM-C2：狀態陳舊（stale view）**
   - 例：使用舊快照做決策，任務已被他人更新。
   - 風險：覆寫新狀態、造成衝突與資料污染。

9. **FM-C3：缺少影響範圍（blast radius）提示**
   - 例：不知道這次調整會影響所有 task 還是單一 task。
   - 風險：小螢幕下高衝擊操作被低估。

## D. 延遲決策（Delayed Decision）

10. **FM-D1：應急決策逾時**
    - 例：blocked 任務長時間無回覆，DAG 卡死。
    - 風險：吞吐下降、下游連鎖延遲。

11. **FM-D2：高風險決策被長期懸置**
    - 例：proposal 一直 pending，問題持續惡化。
    - 風險：運行品質下降且無明確責任點。

12. **FM-D3：通知疲勞導致忽略關鍵決策**
    - 例：太多提醒導致真正高優先事件被略過。
    - 風險：重大事故反應延遲。

## E. 治理與可追責失效（Governance Failure）

13. **FM-E1：lesson/policy 改動無審計鏈**
    - 風險：事後無法回答「誰、何時、為何改」。

14. **FM-E2：可回滾性不足**
    - 風險：壞策略只能靠人工補丁，修復慢且不完整。

15. **FM-E3：mobile 與 desktop 權限邊界不清**
    - 風險：手機端越權做本應在桌面完成的高風險變更。

---

## 2) 風險矩陣（v0）

| 失敗模式 | 機率 | 影響 | 系統性風險 | 主要防護 |
|---|---|---|---|---|
| FM-A1/A2 誤判趨勢 | 中 | 高 | 策略震盪、品質不穩 | 最小樣本門檻 + 觀察窗 + 延遲生效 |
| FM-A3 風險估錯 | 低~中 | 高 | 高風險變更誤自動生效 | 風險分級強制閘門 |
| FM-B1/B2 誤觸 | 高 | 中~高 | 錯誤狀態寫入、觸發自動化 | 雙重確認 + Undo window |
| FM-C1 上下文不足 | 高 | 高 | 錯誤決策常態化 | 決策卡最小資訊集 + 展開詳情 |
| FM-C2 陳舊狀態 | 中 | 高 | 併發覆寫、資料污染 | ETag/版本檢查 + 衝突提示 |
| FM-D1 決策逾時 | 中 | 中~高 | pipeline 阻塞、吞吐下降 | SLA/TTL + 安全預設 fallback |
| FM-D3 通知疲勞 | 高 | 中 | 關鍵事件延誤 | 通知分層與節流 |
| FM-E1/E2 無審計回滾 | 低~中 | 極高 | 不可追責、不可恢復 | append-only audit + 一鍵回滾 |

> 優先順序：先解決 **C/B/E 類**（上下文、誤觸、審計回滾），再優化 A/D 類（判斷品質與時效）。

---

## 3) 防護欄設計

## 3.1 哪些操作需要雙重確認或可逆機制

### 必須「雙重確認」的操作（手機端）
- 任何會改 `controls` 的操作（如 `auto_review`, `auto_redispatch`, `quality_threshold`, `review_agent`）
- 任務狀態的高影響跳轉（例如 `completed -> approved` 手動覆蓋）
- proposal/insight 的「apply to global」
- 批量操作（batch dispatch、批量狀態變更）

### 必須「可逆」的操作（至少有短窗口可撤銷）
- 單一 task 狀態變更
- 單一 proposal approve/reject
- low-risk controls patch（需保留前值快照）

### 不應在手機端直接執行（需桌面端）
- lesson/policy 的全域生效、停用、覆蓋（supersede）
- 刪除或重寫審計資料
- 影響多任務/多 agent 的批量治理操作

## 3.2 安全等級（Safety Levels）

定義三層，與操作衝擊範圍綁定，而非單純看按鈕類型。

### **S0：可即時生效（Instant）**
條件：低衝擊、可局部修正、無全域副作用。  
例：新增 signal/insight、留言、標記待辦、通知確認收悉。

### **S1：需確認（Confirm）**
條件：中衝擊或可能觸發下游流程，但可回滾。  
機制：二次確認 + 5~15 分鐘 Undo window + 版本檢查。  
例：單一 task 狀態變更、單筆 proposal approve/reject。

### **S2：需桌面端處理（Desktop Only）**
條件：高衝擊、全域性、不可逆或高審計要求。  
機制：桌面完整上下文 + diff 檢視 + 審批記錄。  
例：全域 policy/lesson 生效、controls 大幅調整、批量治理。

## 3.3 決策前最小資訊集（Mobile Decision Card）

任何 S1/S2 決策前，至少顯示：
1. 影響範圍（單一 task / 多 task / 全域）
2. 目前值 vs 變更後值（diff）
3. 來源證據（對應 signal/insight）
4. 最後更新時間與版本（避免 stale）
5. 可回滾方式與期限

缺任一欄位：**禁止提交，只能存 draft**。

## 3.4 延遲決策防失控

- 每個待決策項目要有 `decision_ttl`（如 30 分鐘 / 4 小時 / 24 小時）
- TTL 到期後採「安全預設」：
  - 對高風險：預設不生效（fail-safe no-op）
  - 對阻塞流程：可觸發升級通知給桌面端處理者
- 通知節流：同類事件聚合，避免通知疲勞

---

## 4) lesson/policy 變動的審計與回滾設計

## 4.1 審計模型（Append-only ChangeLog）

每次變更產生不可覆蓋的變更記錄：

```json
{
  "changeId": "chg-20260227-001",
  "ts": "2026-02-27T03:00:00+08:00",
  "actor": "human:<id>",
  "client": "mobile|desktop",
  "target": "lesson|policy|controls",
  "targetId": "les-...",
  "action": "create|apply|update_status|supersede|rollback",
  "before": {"status": "active"},
  "after": {"status": "superseded"},
  "reason": "retro evidence #ins-...",
  "refs": ["sig-...", "ins-..."],
  "risk": "low|medium|high",
  "approvedBy": "human:<id>|null"
}
```

關鍵：**不覆寫歷史，只追加事件**，可完整重建任意時點狀態。

## 4.2 回滾策略

1. **版本化快照**：policy/lesson 每次生效都建立版本號（vN）。
2. **一鍵回滾**：`rollback(targetId, toVersion)` 產生新事件，不刪舊事件。
3. **回滾安全檢查**：
   - 不可跨越 schema 不相容版本
   - 回滾前先模擬 impact（受影響 task 數）
4. **回滾後觀察期**：自動建立 signal 追蹤回滾效果（避免反覆震盪）。

## 4.3 兩階段生效（建議）

- **Stage 1（mobile）**：只能建立 `draft proposal/lesson`。
- **Stage 2（desktop）**：檢視完整 diff 與 evidence 後才可 `apply`。

這可兼顧手機端的即時判斷輸入與高風險治理的安全性。

---

## 5) v0 最小安全策略（MUST / SHOULD）

## MUST（必做）

1. **風險分級強制執行**：所有可變更操作都要標記 S0/S1/S2，未分級不得上線。  
2. **S1 雙重確認 + Undo**：S1 至少二次確認，且提供短時間撤銷。  
3. **S2 桌面限定**：S2 操作在手機端只能建立草稿，不可直接生效。  
4. **版本一致性檢查**：提交時必須驗證版本/ETag，避免 stale write。  
5. **Append-only 審計**：lesson/policy/controls 變更必須可追溯到 actor、reason、refs。  
6. **可回滾**：所有 policy/lesson 生效都必須有可執行回滾路徑。  
7. **無硬刪除（mobile）**：手機端不得提供刪除審計與歷史資料。  
8. **TTL 與 fail-safe**：待決策項目必須有逾時策略，高風險預設不生效。

## SHOULD（建議）

1. 決策卡提供最小資訊集（blast radius / diff / evidence / rollback）。  
2. 高風險按鈕採長按或文字確認（降低誤觸）。  
3. 通知採分級與聚合，限制噪音。  
4. 對 policy 變更提供「沙盒模擬影響」再提交。  
5. 對頻繁回滾或震盪行為自動產生 signal，交給 operational 層分析。

---

## 6) 結論（v0 定位）

手機端 judgment slot 的定位應是：**快速注入判斷、有限授權決策、嚴格可追溯**。  
v0 不追求在手機完成完整治理，而是確保「錯了可停、可查、可退」。  
只要守住分級閘門 + 審計回滾，系統就能在保守安全下逐步提升自動化。