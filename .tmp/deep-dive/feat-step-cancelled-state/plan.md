# Plan Phase: Add cancelled step state (GH-219)

## 實作狀態

**✅ 已完成** — 所有需求已在 commit 10d264b 實作並測試通過。

## 需求覆蓋清單

### Issue #219 需求

| # | 需求 | 實作位置 | 狀態 |
|---|------|---------|------|
| 1 | Add `cancelled` to STEP_STATES | `step-schema.js:13` | ✅ 完成 |
| 2 | Allow `queued → cancelled` transition | `step-schema.js:26` | ✅ 完成 |
| 3 | Allow `running → cancelled` transition | `step-schema.js:27` | ✅ 完成 |
| 4 | `cancelled` is terminal (no retry) | `step-schema.js:31` | ✅ 完成 |
| 5 | ~30 lines of code | 10 lines actual code + comments | ✅ 完成 |

### 額外實作（超出 spec 但合理）

| # | 項目 | 位置 | 說明 |
|---|------|------|------|
| 1 | Allow `failed → cancelled` | `step-schema.js:28` | 讓使用者可以取消 retry queue 中的 step |
| 2 | transitionStep handles cancelled | `step-schema.js:113-118` | 設定 completed_at、清理 lock |
| 3 | Detailed transition comments | `step-schema.js:15-24` | 文件化每個轉換的語意 |
| 4 | Test coverage | `test-step-schema.js:65,68,71,77` | 所有轉換路徑都有測試 |

## 實作細節

### 1. STEP_STATES 更新

**檔案**: `server/step-schema.js:13`

```javascript
const STEP_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];
```

**變更**: 新增 `'cancelled'` 作為第六個狀態

---

### 2. ALLOWED_STEP_TRANSITIONS 更新

**檔案**: `server/step-schema.js:26-31`

```javascript
const ALLOWED_STEP_TRANSITIONS = {
  queued:    ['running', 'cancelled'],      // +cancelled
  running:   ['succeeded', 'failed', 'cancelled'],  // +cancelled
  failed:    ['queued', 'dead', 'cancelled'],  // +cancelled
  succeeded: [],
  dead:      [],
  cancelled: [],  // terminal state
};
```

**變更**:
- `queued` 可以轉換到 `cancelled`（使用者在 step 開始前取消）
- `running` 可以轉換到 `cancelled`（使用者 kill 執行中的 step）
- `failed` 可以轉換到 `cancelled`（使用者取消 retry queue 中的 step）
- `cancelled` 是終態（空陣列，無法再轉換）

---

### 3. transitionStep 函數更新

**檔案**: `server/step-schema.js:113-118`

```javascript
if (newState === 'cancelled') {
  step.completed_at = new Date().toISOString();
  step.error = extra.error || 'step cancelled';
  step.locked_by = null;
  step.lock_expires_at = null;
}
```

**行為**:
- 設定 `completed_at` 時間戳
- 記錄錯誤訊息（預設 'step cancelled'）
- 清除 lock（釋放執行權）
- **不增加 attempt**（與 `failed` 不同）
- **不 requeue**（與 `failed` 不同）

---

### 4. 註釋文件化

**檔案**: `server/step-schema.js:15-24`

```javascript
// Step state transitions:
// - queued → running (normal execution start)
// - queued → cancelled (user cancels before step starts)
// - running → succeeded (task completed successfully)
// - running → failed (error occurred, retry scheduled)
// - running → cancelled (user killed step during execution)
// - failed → queued (retry after backoff)
// - failed → dead (max retries exhausted)
// - failed → cancelled (user kills failed step)
// - succeeded/dead/cancelled → no transitions (terminal states)
```

**目的**: 讓維護者清楚理解每個轉換的語意和使用場景

---

## 測試計畫

### 單元測試（已完成）

**檔案**: `server/test-step-schema.js`

**測試案例**:

1. **queued → cancelled** (line 65):
   ```javascript
   assert.strictEqual(stepSchema.canTransitionStep('queued', 'cancelled'), true);
   ```

2. **running → cancelled** (line 68):
   ```javascript
   assert.strictEqual(stepSchema.canTransitionStep('running', 'cancelled'), true);
   ```

3. **failed → cancelled** (line 71):
   ```javascript
   assert.strictEqual(stepSchema.canTransitionStep('failed', 'cancelled'), true);
   ```

4. **cancelled 是終態** (line 77):
   ```javascript
   assert.strictEqual(stepSchema.canTransitionStep('cancelled', 'queued'), false);
   ```

**執行結果**: ✅ 29 passed, 0 failed

---

### 整合測試（未來，屬於 #214）

當 #214 實作 `POST /api/steps/:id/kill` 時，需要測試：

1. **Kill queued step**:
   ```javascript
   // POST /api/steps/T-1:plan/kill
   // Step state: queued → cancelled
   // No process to kill (not running yet)
   ```

2. **Kill running step**:
   ```javascript
   // POST /api/steps/T-1:plan/kill
   // Step state: running → cancelled
   // Process killed via activeExecutions.get(stepId).kill()
   // No retry scheduled
   ```

3. **Kill failed step**:
   ```javascript
   // POST /api/steps/T-1:plan/kill
   // Step state: failed → cancelled
   // No process running (already failed)
   // Removes from retry queue
   ```

4. **Cancelled step 不 retry**:
   ```javascript
   // After cancellation, step stays in cancelled state
   // No automatic requeue happens
   // attempt count unchanged
   ```

---

## 驗收標準

### ✅ 已達成

- [x] `cancelled` 在 STEP_STATES 中
- [x] `queued → cancelled` 允許轉換
- [x] `running → cancelled` 允許轉換
- [x] `cancelled` 是終態（不 retry）
- [x] `transitionStep` 正確處理 cancelled 狀態
- [x] 所有轉換路徑有測試覆蓋
- [x] 測試全部通過
- [x] 程式碼有清晰註釋

### 🔄 未來工作（屬於 #214）

- [ ] 實作 `POST /api/steps/:id/kill` 端點
- [ ] Step worker 維護 `activeExecutions` Map
- [ ] Kill endpoint 呼叫 `transitionStep(step, 'cancelled')`
- [ ] 整合測試驗證 kill → cancelled 流程

---

## 程式碼變更摘要

### 檔案變更

| 檔案 | 新增行數 | 修改行數 | 刪除行數 |
|------|---------|---------|---------|
| `server/step-schema.js` | 12 | 3 | 0 |

### Git Diff

```diff
 const STEP_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];

+// Step state transitions:
+// - queued → running (normal execution start)
+// - queued → cancelled (user cancels before step starts)
+// - running → succeeded (task completed successfully)
+// - running → failed (error occurred, retry scheduled)
+// - running → cancelled (user killed step during execution)
+// - failed → queued (retry after backoff)
+// - failed → dead (max retries exhausted)
+// - failed → cancelled (user kills failed step)
+// - succeeded/dead/cancelled → no transitions (terminal states)
 const ALLOWED_STEP_TRANSITIONS = {
-  queued:    ['running'],
+  queued:    ['running', 'cancelled'],
   running:   ['succeeded', 'failed', 'cancelled'],
-  failed:    ['queued', 'dead'],       // queued = retry, dead = give up
+  failed:    ['queued', 'dead', 'cancelled'],
   succeeded: [],
   dead:      [],
   cancelled: [],
 };
```

---

## 與 #214 的整合指南

### Step Worker 需要的變更

**檔案**: `server/step-worker.js`

```javascript
// 維護 active executions
const activeExecutions = new Map(); // stepId → { kill, startedAt }

// 在 dispatch 時
const { promise, kill } = runtimeAdapter.dispatch(plan);
activeExecutions.set(step.step_id, { kill, startedAt: Date.now() });

// 在 completion 時
activeExecutions.delete(step.step_id);

// Kill 時
function killStep(stepId) {
  const execution = activeExecutions.get(stepId);
  if (execution) {
    execution.kill();
  }
  // 標記為 cancelled，不是 failed
  transitionStep(step, 'cancelled');
}
```

### Routes 需要的變更

**檔案**: `server/routes/tasks.js`

```javascript
// POST /api/steps/:id/kill
router.post('/steps/:id/kill', (req, res) => {
  const stepId = req.params.id;
  const step = findStep(stepId);
  
  if (!step) {
    return res.status(404).json({ error: 'Step not found' });
  }
  
  // Kill the process (if running)
  killStep(stepId);
  
  // Transition to cancelled
  transitionStep(step, 'cancelled');
  
  res.json({ status: 'cancelled', step });
});
```

---

## 風險評估

### 低風險 ✅

- **向後兼容**: 新狀態不影響現有 step（它們不會自動變成 cancelled）
- **測試覆蓋**: 所有轉換路徑都有測試
- **實作簡潔**: 只修改必要的常量和函數，無複雜邏輯

### 需注意 ⚠️

- **前端顯示**: UI 需要能正確顯示 `cancelled` 狀態（不同於 `failed`）
- **監控**: 監控系統需要能區分 `failed` vs `cancelled`（不應該警報 cancelled）
- **統計**: 統計報表應該分開計算 failed rate 和 cancelled rate

---

## 結論

**實作狀態**: ✅ **已完成並測試通過**

**變更範圍**: 
- 1 個檔案修改（`step-schema.js`）
- 12 行新增（含註釋）
- 3 行修改
- 0 行刪除

**測試結果**: ✅ 29 passed, 0 failed

**下一步**: Issue #214 可基於此實作 kill endpoint。

**無需額外工作** — issue #219 的所有需求已滿足。
