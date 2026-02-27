# Evolution Layer — Architecture Contract

> 所有 Task agent 開始前必須讀這份文件。
> 違反這些規則的實作視為不完整。

---

## 規則表

| Rule ID | 描述 | 驗證方式 | 影響 Tasks |
|---------|------|---------|-----------|
| EVO-01 | signals/insights/lessons 必須存放在 board.json 裡，不可另開檔案 | `node -e "const b=require('./board.json'); console.log(Array.isArray(b.signals), Array.isArray(b.insights), Array.isArray(b.lessons))"` 全部 true | T1, T2, T3, T4, T5 |
| EVO-02 | 所有 board 寫入必須走 `writeBoard()` 或 `helpers.writeBoard()`，保證 SSE 推送 | `grep -n "fs.writeFileSync.*board" server.js` 不可有新增的直接寫入（process-review.js 例外，已在 CONTRACT 允許） | T1, T5 |
| EVO-03 | 每筆 signal/insight/lesson 必須有 `id` 和 `ts` 欄位 | 驗收時 GET /api/signals 回傳每筆都有 id + ts | T1, T2, T3 |
| EVO-04 | signal 只記事實，不含判斷。judgement 和 suggestedAction 只出現在 insight | 審查 signal schema 不含 judgement / suggestedAction 欄位 | T2, T3 |
| EVO-05 | 零外部依賴 — retro.js 只用 Node.js 內建模組 + blackboard-server.js | `grep -n "require(" retro.js` 除了 fs/path/http/child_process 和 ../blackboard-server 外不可有其他 | T3 |
| EVO-06 | insight 的 suggestedAction 必須是可機器執行的 patch，不是自然語言描述 | suggestedAction.type 必須是 enum: `controls_patch`, `dispatch_hint`, `lesson_write`, `noop` | T3, T5 |
| EVO-07 | Gate 對 low-risk insight **預設自動執行**。medium/high 仍等人。 | `grep -n "auto_apply_insights" server.js` 確認預設 true；確認只在 risk === 'low' 時自動 | T5 |
| EVO-08 | lesson 注入 dispatch 不可超過 500 字元（避免 token 爆炸） | buildTaskDispatchMessage 中 lesson 注入段落 <= 500 chars | T5 |
| EVO-09 | UI 的 evolution panel 必須是可收合的（不影響現有任務管理 UI） | 手動確認 evolution panel 有 collapse 開關 | T4 |
| EVO-10 | 新增 API endpoint 必須遵循現有命名慣例：`/api/<resource>` | 新 endpoint 路徑格式一致 | T1 |
| EVO-11 | 自動 apply 必須先快照、後驗證。效果不佳必須自動回滾。 | applied insight 有 snapshot 欄位；回滾時 controls 還原且寫 rollback signal | T5 |
| EVO-12 | 回滾後 insight 標記 `rolled_back`，不可再被自動 apply | 同 suggestedAction 的 insight 被 rolled_back 後不重複出現 | T5 |

---

## Schema 定義

### Signal

```json
{
  "id": "sig-<timestamp>-<random>",
  "ts": "2026-02-25T10:00:00.000Z",
  "by": "process-review.js | server.js | human | retro.js | heartbeat",
  "type": "review_result | status_change | error | pattern | request",
  "content": "人可讀的一句話描述",
  "refs": ["T1", "T2"],
  "data": {}
}
```

**必填**：`id`, `ts`, `by`, `type`, `content`
**選填**：`refs`, `data`

### Insight

```json
{
  "id": "ins-<timestamp>-<random>",
  "ts": "2026-02-25T10:02:00.000Z",
  "by": "retro.js | nox | human",
  "about": "sig-xxx | null",
  "judgement": "人可讀的判斷",
  "reasoning": "為什麼這樣判斷",
  "suggestedAction": {
    "type": "controls_patch | dispatch_hint | lesson_write | noop",
    "payload": {}
  },
  "risk": "low | medium | high",
  "status": "pending | applied | rejected | expired | rolled_back",
  "snapshot": null,
  "appliedAt": null,
  "verifyAfter": 3
}
```

**必填**：`id`, `ts`, `by`, `judgement`, `suggestedAction`, `risk`
**選填**：`about`, `reasoning`, `status`（預設 `pending`）, `snapshot`, `appliedAt`, `verifyAfter`

**snapshot**：auto-apply 前記錄的 controls 快照，用於回滾。格式為被修改的 key-value。
**appliedAt**：apply 的時間戳。用於計算驗證窗口。
**verifyAfter**：apply 後需要多少筆 review signal 才進行效果驗證（預設 3）。

### Lesson

```json
{
  "id": "les-<timestamp>-<random>",
  "ts": "2026-02-25T12:00:00.000Z",
  "by": "retro.js | human | nox",
  "fromInsight": "ins-xxx | null",
  "rule": "一句話的規則",
  "effect": "應用後的觀察到效果",
  "status": "active | validated | invalidated | superseded",
  "validatedAt": "... | null",
  "supersededBy": "les-xxx | null"
}
```

**必填**：`id`, `ts`, `by`, `rule`, `status`
**選填**：`fromInsight`, `effect`, `validatedAt`, `supersededBy`

---

## suggestedAction.type 詳解

### `controls_patch`

直接修改 board.controls。

```json
{
  "type": "controls_patch",
  "payload": { "quality_threshold": 80 }
}
```

執行方式：`Object.assign(board.controls, payload)`

### `dispatch_hint`

建議下次派發時的提示。寫入 `board.controls.dispatch_hints`。

```json
{
  "type": "dispatch_hint",
  "payload": { "taskType": "server", "preferAgent": "engineer_pro" }
}
```

### `lesson_write`

建議將一條 insight 結晶為 lesson。

```json
{
  "type": "lesson_write",
  "payload": { "rule": "server 類任務用 engineer_pro", "fromInsight": "ins-xxx" }
}
```

### `noop`

純觀察，不建議行動。

```json
{
  "type": "noop",
  "payload": {}
}
```

---

## 安全閥

1. **同類型 insight 24 小時內最多自動執行 1 次**
2. **連續 3 次自動執行後強制等 Human 確認**
3. **自動執行前必須快照被修改的 controls（存入 `insight.snapshot`）**
4. **自動執行後必須產生 signal 記錄效果**
5. **apply 後等 `verifyAfter` 筆 review signal，然後自動驗證效果**
6. **驗證失敗 → 自動回滾 controls + insight 標記 `rolled_back` + 寫 rollback signal**
7. **驗證成功 → 結晶 lesson（status: validated）+ insight 保持 applied**
8. **被 rolled_back 的 insight 的 suggestedAction 不可再被自動 apply**
9. **lessons 陣列上限 100 條**（超過時 invalidated/superseded 的自動移到 `lessons_archive`）
10. **signals 陣列上限 500 條**（超過時自動截斷最舊的）

## 自動改善完整流程

```
retro.js 偵測模式
  → 寫 insight (risk: low, suggestedAction: controls_patch)
  → gate 自動 apply：
      1. 快照當前 controls 到 insight.snapshot
      2. 執行 patch
      3. 記錄 apply signal
      4. 設定 appliedAt = now
  → 系統用新 controls 跑接下來的任務
  → 累積 verifyAfter 筆 review signal 後
  → retro.js（或 gate 本身）自動驗證：
      比較 apply 前後的 avg score
      → 改善（+5 以上）→ 寫 lesson (validated) ✅
      → 持平（±5 以內）→ 保持 applied，繼續觀察
      → 惡化（-5 以下）→ 回滾 controls + rolled_back ❌
```

**人的角色從「審批者」變成「被通知者」。** 系統自動改善，人看報告。如果不放心，隨時可以在 UI 關閉 `auto_apply_insights`。

---

## 不改動的部分

- 現有 task status 轉移邏輯（`ALLOWED_TASK_TRANSITIONS`）不變
- 現有 `buildTaskDispatchMessage` 的核心結構不變（T5 只追加 lesson 段落）
- 現有 UI 的任務管理面板不變（T4 只追加新的可收合區塊）
- `blackboard-server.js` 共用核心不改
- `process-review.js` 的審查邏輯不變（T2 只在尾部追加 signal emit）
