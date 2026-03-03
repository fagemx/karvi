# Karvi 上線後維運

> 自動化排程 + 監控指標 + 人類例行任務 + 里程碑檢查點。

---

## 自動化排程

| 排程 | 頻率 | 觸發方式 | 做什麼 | 告警條件 |
|------|------|----------|--------|----------|
| Health check | 每 1 分鐘 | 外部監控 (UptimeRobot / 自建) | `GET /health` 確認 200 | 連續 3 次失敗 → alert |
| Expired lock recovery | Server 啟動時 | server.js 內建 | 清理卡住的 running steps | N/A（自動） |
| Rate limit stale sweep | 每 1 小時 | server.js 內建 | 清理過期的 IP 限流記錄 | N/A（自動） |
| Telemetry batch report | 每 24 小時 | server.js 內建 | 匿名使用統計上報（可關閉） | N/A（可 opt-out） |
| Backup board.json | 每 6 小時 | cron / GitHub Actions | `cp board.json board-$(date).json.bak` | 備份失敗 → alert |
| Log rotation | 每 7 天 | cron | 壓縮 task-log.jsonl 舊紀錄 | Disk > 80% → alert |
| CI tests | 每次 PR | GitHub Actions | syntax + unit + smoke + evolution | 任何失敗 → block merge |
| CD deploy | main merge | GitHub Actions (Week 4+) | test → build → deploy → health check | Deploy 失敗 → rollback + alert |

### Backup Cron 範例（VPS）

```bash
# /etc/cron.d/karvi-backup
0 */6 * * * node /opt/karvi/scripts/backup.sh >> /var/log/karvi-backup.log 2>&1
```

```bash
#!/bin/bash
# scripts/backup.sh
BACKUP_DIR="/opt/karvi/backups"
DATE=$(date +%Y%m%d_%H%M)
mkdir -p "$BACKUP_DIR"
cp /opt/karvi/server/board.json "$BACKUP_DIR/board-$DATE.json"
cp /opt/karvi/server/task-log.jsonl "$BACKUP_DIR/task-log-$DATE.jsonl"
# 保留 7 天
find "$BACKUP_DIR" -name "*.json" -mtime +7 -delete
find "$BACKUP_DIR" -name "*.jsonl" -mtime +7 -delete
echo "[$(date)] Backup completed: board-$DATE.json"
```

### Log Rotation 範例

```bash
# /etc/cron.d/karvi-logrotate
0 3 * * 0 /opt/karvi/scripts/rotate-logs.sh
```

```bash
#!/bin/bash
# scripts/rotate-logs.sh
LOG="/opt/karvi/server/task-log.jsonl"
ARCHIVE="/opt/karvi/logs/task-log-$(date +%Y%m%d).jsonl.gz"
mkdir -p /opt/karvi/logs
if [ -f "$LOG" ] && [ $(wc -l < "$LOG") -gt 10000 ]; then
  # 保留最後 1000 行，其餘壓縮歸檔
  head -n -1000 "$LOG" | gzip > "$ARCHIVE"
  tail -n 1000 "$LOG" > "$LOG.tmp"
  mv "$LOG.tmp" "$LOG"
  echo "[$(date)] Rotated: $(basename $ARCHIVE)"
fi
```

---

## 監控指標

| 指標 | 來源 | 目標（3 個月） | 告警門檻 | 檢查頻率 |
|------|------|----------------|----------|----------|
| Server uptime | Health check | > 99.9% | Down > 3 min | 每分鐘 |
| API response time (p95) | Structured log | < 200ms | > 1000ms | 即時 |
| Error rate | Structured log | < 1% | > 5% | 即時 |
| Active tasks (running) | Board.json | 視需求 | 卡住 > 30 min | 每 10 min |
| Board.json size | File system | < 5MB | > 10MB | 每小時 |
| task-log.jsonl size | File system | < 50MB | > 100MB | 每小時 |
| Disk usage | OS | < 60% | > 80% | 每小時 |
| Memory usage | OS | < 512MB | > 1GB | 每 5 min |
| Dispatch success rate | Usage tracking | > 95% | < 80% | 每小時 |
| Agent avg duration | Usage tracking | < 180s | > 300s | 每小時 |
| Rate limit 429 count | Rate limiter | < 10/hr | > 100/hr（可能被攻擊） | 每小時 |

### SaaS 專屬指標（Week 4+）

| 指標 | 來源 | 目標（6 個月） | 告警門檻 |
|------|------|----------------|----------|
| 月活使用者 (MAU) | Usage tracking | > 50 | < 5（成長問題） |
| 月 dispatches | Usage tracking | > 500 | < 50（使用偏低） |
| MRR (Monthly Recurring Revenue) | Stripe | > $200 | $0 連續 2 個月 |
| Churn rate | Stripe | < 10% | > 30% |
| 付費轉換率 | 自算 | > 5% | < 1% |

---

## 人類例行任務

### 每日（~5 分鐘）—— 只在上線首月

| 任務 | 時間 | 怎麼做 |
|------|------|--------|
| 掃一眼 error log | 2 分鐘 | `ssh vps "tail -20 /opt/karvi/server/error.log"` 或 Fly.io dashboard |
| 確認 health check 綠 | 1 分鐘 | UptimeRobot dashboard 或 `curl /health` |
| 看有沒有 stuck tasks | 2 分鐘 | Web UI → 有沒有 running > 30 min 的 task |

### 每週（~15 分鐘）

| 任務 | 時間 | 頻率 |
|------|------|------|
| 看 GitHub Issues（CI 報告、使用者回報） | 5 分鐘 | 每週一 |
| 看 disk usage + backup 狀態 | 3 分鐘 | 每週一 |
| 看 usage metrics 趨勢 | 5 分鐘 | 每週一 |
| Review 使用者 feedback（如有） | 5 分鐘 | 每週 |

### 每月（~30 分鐘）

| 任務 | 時間 | 頻率 |
|------|------|------|
| 安全更新檢查（Node.js patch, OS updates） | 10 分鐘 | 每月 |
| 備份恢復演練（隨機挑一份 backup 試還原） | 15 分鐘 | 每月 |
| Review 成本（VPS/Fly.io 帳單 vs 收入） | 5 分鐘 | 每月 |

---

## 里程碑檢查點

### T+1 週：首週回顧

- [ ] Server 有沒有 crash 過？幾次？原因？
- [ ] Error rate 多少？
- [ ] 有沒有卡住的 task？
- [ ] 使用者 feedback 有什麼？
- [ ] 需不需要調整 rate limit / timeout？

### T+1 個月：月度回顧

- [ ] Uptime > 99.9%？
- [ ] 有沒有安全事件？
- [ ] Board.json 大小趨勢正常？
- [ ] Task-log.jsonl rotation 正常？
- [ ] 使用者數量 + 趨勢
- [ ] （SaaS）MRR 多少？轉換率？

### T+3 個月：季度評估

- [ ] 架構有沒有瓶頸浮現？
- [ ] 需不需要 SQLite migration（#2）？
- [ ] 需不需要多 node / load balancer？
- [ ] Feature roadmap 優先序重排
- [ ] （SaaS）MRR > $200？如果沒有 → 評估 pivot

### T+6 個月：半年決策點

**Must Review — 人類必須做的決策：**

- MAU > 50？
- MRR > $500？
- Uptime > 99.9%？
- 技術債可控？
- 使用者持續成長？

**如果 MRR < $200 且 MAU < 20：** 認真評估是否繼續投資 SaaS，或只維護 OSS 版。

---

## 緊急應變 SOP

### Server Down

```
1. 確認是真 down（不是網路問題）
   curl -s https://your-domain/health || echo "DOWN"

2. 查 log
   fly logs -a karvi --since 10m   # Fly.io
   ssh vps "journalctl -u karvi --since '10 min ago'"  # VPS

3. 重啟
   fly apps restart karvi           # Fly.io
   ssh vps "systemctl restart karvi"  # VPS

4. 如果重啟後又 crash → 查 board.json 是否損壞
   ssh vps "node -e \"JSON.parse(require('fs').readFileSync('/opt/karvi/server/board.json'))\""

5. 如果損壞 → 從 backup 還原
   ssh vps "cp /opt/karvi/backups/board-latest.json /opt/karvi/server/board.json"
   ssh vps "systemctl restart karvi"
```

### Board.json 損壞

```
1. 停 server
2. 嘗試 board.json.bak
   cp board.json.bak board.json
3. 如果 .bak 也壞 → 從定時 backup 還原
4. 如果 backup 也沒有 → 從 task-log.jsonl 重建（手動）
5. 啟動 server，驗證
```

### 被攻擊（大量 429）

```
1. 查 rate limit log，找 IP
2. 如果是單一 IP → 在 reverse proxy 層 block
   # nginx
   deny 1.2.3.4;
3. 如果是分散 IP → 臨時調低 rate limit
   KARVI_RATE_LIMIT=30 npm start
4. 考慮啟用 Cloudflare Under Attack Mode
```

### Task 卡在 running

```
1. 查 task 詳情
   curl http://localhost:3461/api/tasks/TASK-ID

2. 查是不是 agent process 還在跑
   ps aux | grep openclaw

3. 手動重設 task 狀態
   curl -X POST http://localhost:3461/api/tasks/TASK-ID/status \
     -H "Content-Type: application/json" \
     -d '{"status":"pending"}'

4. 如果是 step 卡住 → 重設 step
   # 透過 board API 或直接編輯 board.json
```

---

*維運手冊完成。搭配 launch-checklist.md 使用。上線後第一個月每天 5 分鐘，穩定後每週 15 分鐘。*
