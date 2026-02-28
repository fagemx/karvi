# Karvi Deployment Guide

> **Looking for the quick self-hosting setup?** See [Self-Hosting Guide](self-hosting.md) for desktop + tunnel in 10 minutes.

本文件說明如何透過反向代理將 Karvi 暴露至外網，並提供 HTTPS 加密。

> **雲端部署** (Fly.io / Railway / Docker) 請參考 [deploy-cloud.md](deploy-cloud.md)。

## 目錄

1. [前置需求](#前置需求)
2. [快速上手 — Cloudflare Tunnel (5 分鐘)](#快速上手--cloudflare-tunnel)
3. [正式部署 — Caddy 反向代理 (30 分鐘)](#正式部署--caddy-反向代理)
4. [環境變數參考](#環境變數參考)
5. [驗證 SSE 連線](#驗證-sse-連線)
6. [疑難排解](#疑難排解)

---

## 前置需求

- Node.js 22+
- Karvi server 可正常啟動 (`npm start`)
- 選擇以下任一方式：
  - **Cloudflare Tunnel** (cloudflared) — 適合自架桌機，不需公網 IP
  - **Caddy** — 適合 VPS / 雲端主機，需要網域和公網 IP

---

## 快速上手 — Cloudflare Tunnel

最簡單的方式，5 分鐘內讓手機透過 HTTPS 連上桌機上的 Karvi。

### 1. 安裝 cloudflared

- **macOS**: `brew install cloudflared`
- **Windows**: `winget install Cloudflare.cloudflared`
- **Linux**: 參考 [官方文件](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

### 2. 啟動 Karvi

```bash
KARVI_API_TOKEN=my-secret-token npm start
```

### 3. 啟動 Tunnel

```bash
bash deploy/tunnel-quick.sh
```

cloudflared 會印出一個隨機 HTTPS URL，例如：
```
https://random-word-1234.trycloudflare.com
```

### 4. 連線

在瀏覽器或手機 App 中輸入該 URL 即可存取。

> **注意**: 匿名 tunnel 的 URL 每次重啟會改變。如需固定 URL，請設定 Named Tunnel（見 `deploy/cloudflared.yml`）。

### Named Tunnel (固定 URL)

```bash
cloudflared tunnel login
cloudflared tunnel create karvi
cloudflared tunnel route dns karvi karvi.example.com
# 編輯 deploy/cloudflared.yml 填入 tunnel UUID
cp deploy/cloudflared.yml ~/.cloudflared/config.yml
cloudflared tunnel run karvi
```

---

## 正式部署 — Caddy 反向代理

適合 VPS 或雲端主機，提供自動 Let's Encrypt TLS 憑證。

### 1. 安裝 Caddy

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

### 2. DNS 設定

將你的網域 A 記錄指向 VPS 的公網 IP：
```
karvi.example.com → 203.0.113.10
```

### 3. 部署 Caddyfile

```bash
# 編輯 deploy/Caddyfile，將 karvi.example.com 替換為你的網域
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```

### 4. 啟動 Karvi

```bash
export KARVI_API_TOKEN=my-secret-token
export KARVI_CORS_ORIGINS=https://karvi.example.com
npm start
```

### 5. 驗證

```bash
curl https://karvi.example.com/health
# 應回傳 {"status":"ok",...}
```

---

## 環境變數參考

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `PORT` | HTTP 監聽 port | `3461` |
| `KARVI_API_TOKEN` | Bearer token 驗證（建議必設） | 無（停用驗證） |
| `KARVI_CORS_ORIGINS` | CORS 允許來源白名單，逗號分隔 | 無（允許所有 `*`） |
| `KARVI_RATE_LIMIT` | 每 IP 每分鐘最大請求數 | `120`（設 `0` 或 `off` 停用） |
| `KARVI_MAX_BODY` | POST/PUT body 大小上限（bytes） | `1048576`（1MB） |
| `KARVI_SSE_LIMIT` | SSE 最大同時連線數 | `50` |
| `KARVI_TRUST_PROXY` | 信任反向代理 IP headers | `false` |

### CORS 白名單範例

```bash
# 單一來源
KARVI_CORS_ORIGINS=https://karvi.example.com

# 多來源（含本地開發）
KARVI_CORS_ORIGINS=https://karvi.example.com,http://localhost:3461

# 未設定 → 向後相容，回傳 Access-Control-Allow-Origin: *
```

### Rate Limiting 設定

Karvi 內建 Token Bucket rate limiter，預設每 IP 每分鐘 120 次請求。
Token Bucket 允許短期突發流量（burst），但長期平均不超過設定限制。

```bash
# 預設值（每 IP 120 req/min）
KARVI_RATE_LIMIT=120

# 寬鬆設定（每 IP 300 req/min）
KARVI_RATE_LIMIT=300

# 停用 rate limiting（不建議用於公網）
KARVI_RATE_LIMIT=off

# 自訂 body 大小上限（2MB）
KARVI_MAX_BODY=2097152

# 自訂 SSE 連線上限
KARVI_SSE_LIMIT=100
```

### 反向代理 IP 信任

在 Caddy / nginx / Cloudflare 後面時，需要啟用 proxy header 信任才能正確辨識客戶端 IP：

```bash
# 啟用後會讀取 X-Forwarded-For 和 CF-Connecting-IP headers
KARVI_TRUST_PROXY=true
```

> **安全提醒**: 僅在確定 server 在反向代理後面時才啟用。直接暴露時啟用此選項，攻擊者可偽造 IP 繞過 rate limit。

Rate limit 回應會包含以下 headers：
- `X-RateLimit-Limit`: 每分鐘最大請求數
- `X-RateLimit-Remaining`: 剩餘可用請求數
- `Retry-After`: 限流時，需等待的秒數
- `X-RateLimit-Reset`: 同 Retry-After

---

## 驗證 SSE 連線

SSE（Server-Sent Events）是 Karvi 即時更新的關鍵。透過 proxy 後需確認 SSE 正常運作。

### 方法 1: curl

```bash
curl -N -H "Authorization: Bearer my-secret-token" \
  https://karvi.example.com/api/events
```

應立即看到：
```
event: connected
data: {"ts":"2026-02-28T12:00:00.000Z"}
```

每 30 秒會收到 heartbeat：
```
: heartbeat
```

### 方法 2: 瀏覽器 DevTools

1. 開啟 `https://karvi.example.com`
2. F12 → Network → 篩選 "EventStream"
3. 確認 `/api/events` 連線存在且持續接收 event

### 方法 3: Smoke Test

```bash
node server/smoke-test.js 3461 --token my-secret-token
```

---

## 疑難排解

### SSE 連線立即斷開

**症狀**: EventSource 連線建立後數秒內斷開

**可能原因**: 反向代理啟用了 response buffering

**解法**:
- Caddy: 確認 `flush_interval -1`（已包含在範本 Caddyfile 中）
- nginx: 加入 `proxy_buffering off;`
- Cloudflare: 確認 SSE 心跳正常（30 秒一次）

### SSE 連線 2 分鐘後斷開

**症狀**: 空閒 2 分鐘後連線被切斷

**可能原因**: proxy 的 idle timeout 小於 heartbeat 間隔

**解法**: Karvi 內建 30 秒 heartbeat，大多數 proxy 的預設 timeout 是 60-120 秒，應能正常工作。若仍斷開，檢查 proxy 的 read timeout 設定。

### CORS 錯誤

**症狀**: 瀏覽器 console 出現 `Access-Control-Allow-Origin` 錯誤

**解法**:
1. 確認 `KARVI_CORS_ORIGINS` 包含你的前端 URL（含 protocol）
2. 注意尾端不要有 `/`：用 `https://karvi.example.com`，不是 `https://karvi.example.com/`
3. 開發時若不確定，可暫時不設定此變數（回退到 `*`）

### Cloudflared Tunnel 無法連線

**症狀**: `cloudflared tunnel` 啟動但無法存取

**解法**:
1. 確認 Karvi server 正在執行：`curl http://localhost:3461/health`
2. 確認 port 正確（預設 3461）
3. 檢查防火牆是否阻擋 cloudflared 的 outbound 連線
