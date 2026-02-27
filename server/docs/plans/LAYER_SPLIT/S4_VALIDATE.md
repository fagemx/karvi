# S4: 全量驗證

## 目標

確認拆分後行為 100% 不變。

## 前置條件

- S1, S2, S3 全部完成

## 驗證清單

### 1. 語法檢查

```bash
node -c management.js
node -c runtime-openclaw.js
node -c server.js
```

三個都必須通過。

### 2. Module 載入測試

```bash
node -e "const m = require('./management'); console.log('management:', Object.keys(m).length, 'exports'); const r = require('./runtime-openclaw'); console.log('runtime:', Object.keys(r).length, 'exports')"
```

預期：
```
management: 21 exports
runtime: 4 exports
```

### 3. Smoke Test

```bash
# 確保 server 在 3461 跑
node server.js &
sleep 2

# 跑 smoke test（應該 9/9 通過）
node ../../smoke-test.js 3461
```

### 4. Evolution Loop Test

```bash
# 清 board 的 evolution 資料
node -e "var fs=require('fs');var p='board.json';var b=JSON.parse(fs.readFileSync(p,'utf8'));b.signals=[];b.insights=[];b.lessons=[];fs.writeFileSync(p,JSON.stringify(b,null,2));console.log('cleaned')"

# 跑完整進化迴路測試
node test-evolution-loop.js
```

預期：全部步驟 ✅，Part A + Part B 通過。

### 5. 行數確認

```bash
wc -l management.js runtime-openclaw.js server.js
```

預期：
- management.js: ~600 行
- runtime-openclaw.js: ~100 行
- server.js: < 1400 行
- 三者合計 ≈ 原始 server.js 的 1996 行

### 6. 獨立性確認

```bash
# management.js 可以在不啟動 server 的情況下被 require
node -e "
const m = require('./management');
const board = { controls: {}, signals: [], insights: [], lessons: [] };
const ctrl = m.getControls(board);
console.log('auto_apply_insights:', ctrl.auto_apply_insights);
console.log('quality_threshold:', ctrl.quality_threshold);
m.ensureEvolutionFields(board);
console.log('board has signals:', Array.isArray(board.signals));
console.log('PASS: management.js is independent');
"
```

## 失敗處理

如果任何測試失敗：
1. 檢查 `mgmt.` / `runtime.` 前綴是否遺漏
2. 檢查 management.js 的 `module.exports` 是否漏了函式
3. 檢查 `spawnReview` 的 callback 改造是否正確傳遞了 `ctx.boardPath`

## 完成標記

更新 `00_OVERVIEW.md` 的 Progress Tracker：
```
[x] S1: management.js
[x] S2: runtime-openclaw.js
[x] S3: server.js 薄殼
[x] S4: 全量驗證
```
