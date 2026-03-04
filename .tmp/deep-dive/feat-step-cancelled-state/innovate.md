# Innovation Phase: Add cancelled step state (GH-219)

## 設計決策分析

由於此 issue 的實作已完成並測試通過，本階段回顧已採用的設計決策，並評估是否有更好的替代方案。

## 已採用的設計

### 方案 A：單一 `cancelled` 終態（已實作）

**狀態機**：
```
queued ────→ cancelled (終態)
running ───→ cancelled (終態)
failed ────→ cancelled (終態)
```

**優點**：
- ✅ 簡潔明確 — 單一終態代表「使用者主動停止」
- ✅ 無 retry — `cancelled` 不會進入 retry loop
- ✅ 語意清晰 — 與 `failed`（出錯）和 `dead`（retry 耗盡）區分明確
- ✅ 實作簡單 — `transitionStep` 只需處理一個新狀態

**缺點**：
- ⚠️ 無法區分「使用者取消排隊」vs「使用者 kill 執行中的 step」
- ⚠️ 無法追蹤「kill 過程是否完成」（如果有非同步 cleanup）

**實作細節**：
```javascript
// transitionStep 處理 cancelled
if (newState === 'cancelled') {
  step.completed_at = new Date().toISOString();
  step.error = extra.error || 'step cancelled';
  step.locked_by = null;
  step.lock_expires_at = null;
}
```

## 替代方案評估

### 方案 B：雙狀態 `cancelling` + `cancelled`

**狀態機**：
```
queued ────→ cancelled (終態)
running ───→ cancelling → cancelled (終態)
failed ────→ cancelling → cancelled (終態)
```

**優點**：
- ✅ 可以追蹤 kill 過程（例如等待 child process 終止）
- ✅ 可以在 `cancelling` 狀態執行 cleanup（釋放資源、通知其他 service）

**缺點**：
- ❌ 複雜度增加 — 需要處理 `cancelling` 狀態的所有邊緣情況
- ❌ Issue spec 明確說明「No `cancelling` state needed — kill is synchronous (PID kill), transition is immediate」
- ❌ Karvi 的 kill 是同步的（`taskkill /T /F` 或 `kill -9`），不需要中間狀態

**結論**：❌ 不採用 — 違反 spec 且增加不必要的複雜度

---

### 方案 C：不新增狀態，用 error code 區分

**實作**：
```javascript
// 失敗時標記不同的 error
transitionStep(step, 'failed', { error: 'USER_CANCELLED' }); // 使用者取消
transitionStep(step, 'failed', { error: 'TIMEOUT' });        // 超時
transitionStep(step, 'failed', { error: 'UNKNOWN' });        // 未知錯誤
```

**優點**：
- ✅ 不修改狀態機，保持向後兼容
- ✅ 可以用 error code 做細緻分類

**缺點**：
- ❌ 語意混淆 — `failed` 原本是「出錯了應該 retry」，但 `USER_CANCELLED` 不應該 retry
- ❌ 需要在 retry logic 中特殊處理 `USER_CANCELLED`（違反 SRP）
- ❌ 不符合 issue spec 的語意設計（failed vs cancelled 應該是不同狀態）

**結論**：❌ 不採用 — 違反語意設計，會導致 retry logic 變複雜

---

### 方案 D：`failed` → `cancelled` 不允許（只允許 queued/running → cancelled）

**狀態機**：
```
queued ────→ cancelled (終態)
running ───→ cancelled (終態)
failed ────→ queued (retry) 或 dead (終態)
```

**優點**：
- ✅ 更嚴格 — 只有「可 kill」的狀態才能轉到 cancelled
- ✅ 語意更清晰 — failed step 只能 retry 或放棄（dead）

**缺點**：
- ❌ 使用者無法 kill 已經 failed 但還在 retry queue 中的 step
- ❌ Issue #214 的 spec 提到「kill failed step」應該是允許的

**實際需求分析**：
從 #214 的 spec 來看：
```
// POST /api/steps/:id/kill
activeExecutions.get(stepId)?.kill()  // 只能 kill 正在執行的
transitionStep(step, 'cancelled')
```

如果 step 已經 failed 並 requeued，它不在 `activeExecutions` 中，無法被 kill。因此 `failed → cancelled` 在當前架構下**可能不需要**。

**但是**，考慮以下場景：
1. Step failed，attempt = 1，scheduled_at = now + 5s
2. 使用者在 5s 內發現問題，想取消 retry
3. 如果不允許 failed → cancelled，使用者只能等它 retry 再 kill，或等它變成 dead

**結論**：✅ **保留當前實作** — 允許 `failed → cancelled` 提供更好的使用者體驗

## 語意設計決策

### 為什麼需要三個終態？

| 狀態 | 語意 | Retry 行為 | 使用者動作 |
|------|------|-----------|-----------|
| `succeeded` | 成功完成 | N/A | 無需動作 |
| `dead` | Retry 次數耗盡，放棄 | 不再 retry | 可手動 re-dispatch |
| `cancelled` | 使用者主動停止 | **不 retry** | 可手動 re-dispatch |

**關鍵差異**：
- `failed` → `dead`：系統自動判定（attempt >= max_attempts）
- `failed` → `cancelled`：使用者主動介入

### 為什麼 `cancelled` 不 retry？

**原因 1：語意正確性**
使用者明確表示「我不要這個 step 繼續執行」，retry 違反使用者意圖。

**原因 2：實用性**
如果使用者 kill 一個 step，通常是因為：
- 發現 step 的 input 有問題（不應該 retry 相同的錯誤 input）
- 需求改變（不應該繼續執行舊需求）
- 資源限制（不應該浪費資源 retry）

**原因 3：與 #214 的整合**
```javascript
// POST /api/steps/:id/kill
activeExecutions.get(stepId).kill();
transitionStep(step, 'cancelled'); // 明確標記「使用者 kill」，不是「出錯」
```

如果 kill 後標記為 `failed`，會觸發 retry，使用者需要 kill 多次直到 `dead`。

## 程式碼品質評估

### 已實作的優點

1. **清晰的註釋**（`step-schema.js:15-24`）：
   ```javascript
   // - queued → cancelled (user cancels before step starts)
   // - running → cancelled (user killed step during execution)
   // - failed → cancelled (user kills failed step)
   // - succeeded/dead/cancelled → no transitions (terminal states)
   ```

2. **完整的測試覆蓋**：
   - 所有轉換路徑都有測試
   - 終態驗證（cancelled 不能轉到其他狀態）
   - 測試全部通過（29 passed, 0 failed）

3. **簡潔的實作**：
   - 只修改必要的常量和函數
   - 無額外的抽象或過度設計
   - 約 10 行實際程式碼變更（不含註釋）

### 潛在改進點（未來考慮）

1. **取消原因追蹤**：
   ```javascript
   transitionStep(step, 'cancelled', { 
     error: 'User requested kill via API',
     cancelled_by: 'user@example.com',
     cancelled_at: new Date().toISOString()
   });
   ```
   - 目前 `error` 欄位可以部分滿足此需求
   - 未來如果需要更詳細的 audit trail，可以新增 `cancellation_reason` 欄位

2. **統計資訊**：
   - 追蹤 cancelled step 的比例
   - 分析 cancellation 原因（input 錯誤 vs 需求改變）
   - 目前可以在 `step.error` 中查詢

## 最終決策

✅ **採用方案 A**（已實作）：
- 單一 `cancelled` 終態
- 允許 queued/running/failed → cancelled
- `transitionStep` 簡潔處理 cancelled 狀態
- 無 `cancelling` 中間狀態（kill 是同步的）

**理由**：
1. 符合 issue spec 所有要求
2. 語意清晰，與 failed/dead 區分明確
3. 實作簡潔，無過度設計
4. 測試完整，覆蓋所有轉換路徑
5. 為 #214 提供良好的基礎

**無需修改** — 當前實作已是最優解。
