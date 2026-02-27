# T4: Evolution UI Panel

> Batch 2（T1 完成後，可與 T2、T3 並行）
> 改動檔案：`project/task-engine/index.html`
> 預估：2-3 小時

---

## 開始前

```bash
# Step 1: 讀契約
cat project/task-engine/docs/plans/EVOLUTION_LAYER/CONTRACT.md

# Step 2: 確認 T1 已完成 — API 可用
curl -s http://localhost:3461/api/signals
curl -s http://localhost:3461/api/insights
curl -s http://localhost:3461/api/lessons

# Step 3: 瀏覽現有 index.html，理解 CSS 風格和 JS 結構
# 特別注意：SSE 連線邏輯、renderXxx() 函數命名慣例、現有的 panel 收合方式

# Step 4: 執行下方步驟
```

---

## 最終結果

- index.html 底部新增「進化面板」（Evolution Panel）
- 可收合（預設收合），不影響現有任務管理 UI
- 顯示 signals、insights、lessons 三個 tab
- signals tab：時間線列表，每筆顯示 by + type + content + 時間
- insights tab：卡片列表，每張顯示 judgement + risk 色標 + [Apply] / [Reject] 按鈕
- lessons tab：表格，每列顯示 rule + status 色標 + 來源
- 即時更新（SSE board 事件自動刷新）
- `node -c index.html` 不適用，但瀏覽器 console 無錯誤

---

## 設計規範

### 視覺風格

沿用 index.html 現有風格（暗色系、圓角卡片、色彩標記狀態）。

**色彩映射**：

| 元素 | 顏色 |
|------|------|
| signal type: review_result | `#4a9eff`（藍） |
| signal type: status_change | `#888`（灰） |
| signal type: error | `#e74c3c`（紅） |
| insight risk: low | `#2ecc71`（綠） |
| insight risk: medium | `#f39c12`（黃） |
| insight risk: high | `#e74c3c`（紅） |
| insight status: applied | `#2ecc71` |
| insight status: rejected | `#888` |
| lesson status: active | `#4a9eff` |
| lesson status: validated | `#2ecc71` |
| lesson status: invalidated | `#e74c3c` |

### 互動

- **[Apply] 按鈕**：`POST /api/insights/:id/apply`，成功後刷新 board
- **[Reject] 按鈕**：`POST /api/insights/:id/apply` 不行。改為直接用 `POST /api/board` 把該 insight 的 status 改為 `rejected`
- **收合開關**：點標題列收合/展開整個 evolution panel

---

## 實作步驟

### Step 1: HTML 結構

在 index.html 的主體內容區塊（現有 task panel 之後），新增：

```html
<!-- Evolution Panel -->
<div id="evo-panel" class="panel">
  <div class="panel-header" onclick="toggleEvoPanel()">
    <span id="evo-toggle">▶</span> 進化面板
    <span id="evo-badge" class="badge" style="margin-left:8px"></span>
  </div>
  <div id="evo-content" style="display:none">
    <div class="evo-tabs">
      <button class="evo-tab active" onclick="switchEvoTab('signals')">Signals</button>
      <button class="evo-tab" onclick="switchEvoTab('insights')">Insights</button>
      <button class="evo-tab" onclick="switchEvoTab('lessons')">Lessons</button>
    </div>
    <div id="evo-tab-signals" class="evo-tab-content"></div>
    <div id="evo-tab-insights" class="evo-tab-content" style="display:none"></div>
    <div id="evo-tab-lessons" class="evo-tab-content" style="display:none"></div>
  </div>
</div>
```

### Step 2: CSS

在 `<style>` 區塊新增進化面板的樣式。沿用現有 panel 的邊距、陰影、字型。

關鍵樣式：
- `.evo-tabs` — flex 橫排 tab 按鈕
- `.evo-tab.active` — 底部色條或背景色區分
- `.evo-signal-item` — 時間線條目（左側時間、右側內容）
- `.evo-insight-card` — 帶色標的卡片
- `.evo-risk-badge` — 小圓角標籤顯示 low/medium/high
- `.evo-lesson-row` — 表格列

### Step 3: JavaScript — 資料渲染

在 `<script>` 區塊新增以下函數：

**toggleEvoPanel()**
```js
function toggleEvoPanel() {
  const content = document.getElementById('evo-content');
  const toggle = document.getElementById('evo-toggle');
  const visible = content.style.display !== 'none';
  content.style.display = visible ? 'none' : 'block';
  toggle.textContent = visible ? '▶' : '▼';
}
```

**switchEvoTab(tab)**
```js
function switchEvoTab(tab) {
  ['signals', 'insights', 'lessons'].forEach(t => {
    document.getElementById('evo-tab-' + t).style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.evo-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase() === tab);
  });
}
```

**renderSignals(signals)**
```
接收 board.signals 陣列（最新在前，最多顯示 50 筆）。
每筆渲染為：
  [時間 HH:MM] [type 色標] [by] content
  如果有 refs，顯示為小標籤。
```

**renderInsights(insights)**
```
接收 board.insights 陣列（最新在前）。
每筆渲染為卡片：
  頂部：risk 色標 + status
  主體：judgement
  底部：suggestedAction.type 標籤
  按鈕：
    - 如果 status === 'pending'：[Apply] [Reject]
    - 如果 status === 'applied'：✅ Applied（灰色）
    - 如果 status === 'rejected'：❌ Rejected（灰色）
```

**renderLessons(lessons)**
```
接收 board.lessons 陣列。
渲染為表格：
  | 規則 | 狀態 | 來源 | 效果 |
狀態用色標（active=藍, validated=綠, invalidated=紅, superseded=灰）。
```

**renderEvolution(board)**
```js
function renderEvolution(board) {
  const signals = (board.signals || []).slice().reverse().slice(0, 50);
  const insights = (board.insights || []).slice().reverse();
  const lessons = (board.lessons || []).filter(l => l.status !== 'invalidated' && l.status !== 'superseded');

  renderSignals(signals);
  renderInsights(insights);
  renderLessons(lessons);

  // badge 顯示 pending insights 數量
  const pending = insights.filter(i => i.status === 'pending').length;
  const badge = document.getElementById('evo-badge');
  badge.textContent = pending > 0 ? `${pending} pending` : '';
  badge.style.display = pending > 0 ? 'inline' : 'none';
}
```

### Step 4: 整合到 SSE 更新

找到現有 SSE 的 board 事件處理邏輯，在 board 更新後呼叫 `renderEvolution(board)`。

類似於現有的 `renderTasks(board)` 呼叫位置，在同一處加上：

```js
renderEvolution(board);
```

也要在頁面初始載入時呼叫一次。

### Step 5: Apply / Reject 按鈕

```js
async function applyInsight(insightId) {
  try {
    const resp = await fetch(`/api/insights/${insightId}/apply`, { method: 'POST' });
    if (!resp.ok) throw new Error(await resp.text());
    // SSE 會自動推送更新
  } catch (e) {
    alert('Apply failed: ' + e.message);
  }
}

async function rejectInsight(insightId) {
  try {
    const board = await fetch('/api/board').then(r => r.json());
    const ins = (board.insights || []).find(i => i.id === insightId);
    if (ins) {
      ins.status = 'rejected';
      await fetch('/api/board', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ insights: board.insights }),
      });
    }
  } catch (e) {
    alert('Reject failed: ' + e.message);
  }
}
```

### Step 6: 自檢

1. 瀏覽器打開 `http://localhost:3461`
2. 確認進化面板顯示在頁面底部
3. 預設收合，點擊可展開
4. 切換 Signals / Insights / Lessons tab
5. 手動 POST 測試資料，確認即時更新：

```bash
# 新增測試 signal
curl -s -X POST http://localhost:3461/api/signals -H "Content-Type: application/json" -d '{"by":"test","type":"review_result","content":"T1 審查通過 (score: 85/70)","data":{"score":85}}'

# 新增測試 insight
curl -s -X POST http://localhost:3461/api/insights -H "Content-Type: application/json" -d '{"by":"test","judgement":"engineer_lite 不適合複雜任務","suggestedAction":{"type":"noop","payload":{}},"risk":"medium"}'
```

6. 確認 [Apply] / [Reject] 按鈕可點擊，狀態即時更新
7. 確認 pending badge 數字正確
8. 確認展開/收合不影響上方的任務管理 UI
