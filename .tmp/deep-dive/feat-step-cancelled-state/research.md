# Research Phase: Add cancelled step state (GH-219)

## 問題理解

Issue #219 要求在 step state machine 中新增 `cancelled` 狀態，讓使用者可以明確標記「被使用者主動停止」的 step，而非讓它落入 `failed` 狀態觸發 retry。

### 核心需求

1. **新增 `cancelled` 到 STEP_STATES**
2. **更新 ALLOWED_STEP_TRANSITIONS**：
   - `queued` 可以轉換到 `cancelled`（使用者在 step 開始前取消）
   - `running` 可以轉換到 `cancelled`（使用者在執行中 kill step）
   - `cancelled` 是終態（empty array，不 retry）
3. **語意區分**：
   - `failed` = 出錯了，應該 retry（直到 max_attempts）
   - `cancelled` = 使用者主動停止，不 retry
   - `dead` = retry 次數耗盡，放棄

### 關聯 Issue

- **#214** — 實作 `POST /api/steps/:id/kill` 端點，會使用 `cancelled` 狀態
- 本 issue (#219) 是 #214 的 dependency

## Codebase 現狀分析

### 1. step-schema.js 結構

**檔案位置**: `server/step-schema.js:13-32`

**當前實作（已部分完成）**：

```javascript
const STEP_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled'];

const ALLOWED_STEP_TRANSITIONS = {
  queued:    ['running', 'cancelled'],
  running:   ['succeeded', 'failed', 'cancelled'],
  failed:    ['queued', 'dead', 'cancelled'],
  succeeded: [],
  dead:      [],
  cancelled: [],
};
```

**transitionStep 函數已支援 cancelled**：

`server/step-schema.js:113-118` 已有 cancelled 處理邏輯：
```javascript
if (newState === 'cancelled') {
  step.completed_at = new Date().toISOString();
  step.error = extra.error || 'step cancelled';
  step.locked_by = null;
  step.lock_expires_at = null;
}
```

### 2. 歷史變更

從 git history 追蹤：

- **Commit 10d264b** — "chore: auto-finalize step GH-219:plan for GH-219"
  - 新增 queued → cancelled 轉換
  - 新增 failed → cancelled 轉換
  - 新增詳細註釋說明每個轉換的語意

- **更早之前** — cancelled 狀態和 running → cancelled 轉換已存在
  - `transitionStep` 函數已有 cancelled 處理
  - `cancelled` 已在 STEP_STATES 中

### 3. 測試覆蓋

**test-step-schema.js** 包含完整測試：

```javascript
// Line 65: queued → cancelled
assert.strictEqual(stepSchema.canTransitionStep('queued', 'cancelled'), true);

// Line 68: running → cancelled  
assert.strictEqual(stepSchema.canTransitionStep('running', 'cancelled'), true);

// Line 71: failed → cancelled
assert.strictEqual(stepSchema.canTransitionStep('failed', 'cancelled'), true);

// Line 77: cancelled 是終態（不允許轉換到其他狀態）
assert.strictEqual(stepSchema.canTransitionStep('cancelled', 'queued'), false);
```

測試結果：**29 passed, 0 failed** ✅

## 狀態機完整圖譜

```
queued ─────┬─→ running ───┬─→ succeeded (終態)
            │              │
            │              ├─→ failed ───┬─→ queued (retry)
            │              │             │
            │              │             ├─→ dead (終態)
            │              │             │
            └─→ cancelled  └─→ cancelled └─→ cancelled (終態)
                (終態)          (終態)         ↑
                                              │
                                          failed ──┘
```

**終態**：succeeded, dead, cancelled（無法再轉換）

**關鍵差異**：
- `failed` → `queued` (retry) 或 `dead` (give up) 或 `cancelled` (user kill)
- `cancelled` 直接終止，不進入 retry loop

## 與 #214 的整合點

當 #214 實作 `POST /api/steps/:id/kill` 時：

1. **Kill endpoint** (`routes/tasks.js`)：
   ```javascript
   // POST /api/steps/:id/kill
   activeExecutions.get(stepId).kill();  // 終止 process
   transitionStep(step, 'cancelled');    // 標記為 cancelled，不是 failed
   // 不會觸發 retry scheduling
   ```

2. **Step worker** (`step-worker.js`)：
   - 維護 `activeExecutions` Map（stepId → { kill, startedAt }）
   - Kill 時呼叫 `transitionStep(step, 'cancelled')`

3. **Retry policy 差異**：
   - `failed` 狀態會在 `transitionStep` 中自動 requeue（如果 attempt < max_attempts）
   - `cancelled` 狀態直接終止，`transitionStep` 只設定 completed_at 和清理 lock

## 實作完整性檢查

✅ **已完成項目**：

1. `cancelled` 在 STEP_STATES 中
2. `queued → cancelled` 允許轉換
3. `running → cancelled` 允許轉換
4. `failed → cancelled` 允許轉換
5. `cancelled` 為終態（empty array）
6. `transitionStep` 函數處理 cancelled 狀態
7. 測試覆蓋所有轉換路徑

❌ **未完成/需確認**：

無 — 所有需求已實作並測試通過

## 程式碼證據

| 需求 | 實作位置 | 狀態 |
|------|---------|------|
| cancelled 在 STEP_STATES | `step-schema.js:13` | ✅ |
| queued → cancelled | `step-schema.js:26` | ✅ |
| running → cancelled | `step-schema.js:27` | ✅ |
| failed → cancelled | `step-schema.js:28` | ✅ |
| cancelled 為終態 | `step-schema.js:31` | ✅ |
| transitionStep 處理 cancelled | `step-schema.js:113-118` | ✅ |
| 測試覆蓋 | `test-step-schema.js:65,68,71,77` | ✅ |

## 結論

**實作狀態**：✅ **已完成**

Issue #219 的所有需求已在 commit 10d264b 中完成：
- 新增 `cancelled` 狀態到 STEP_STATES
- 更新所有必要的轉換規則（queued, running, failed → cancelled）
- `cancelled` 正確標記為終態
- `transitionStep` 函數完整處理 cancelled 狀態
- 測試全部通過（29 passed, 0 failed）

**無需額外實作** — codebase 已符合所有 spec 要求。

**下一步**：Issue #214 可基於此實作 kill endpoint。
