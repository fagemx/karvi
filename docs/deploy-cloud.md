# Karvi 雲端部署指南

本文件說明如何將 Karvi 部署至雲端環境（Fly.io、Docker + VPS、Railway）。

> **本地 / Tunnel 部署**請參考 [deploy.md](deploy.md)。

## 目錄

1. [前置需求](#前置需求)
2. [Fly.io 部署 (5 分鐘)](#flyio-部署)
3. [Docker + VPS 部署 (30 分鐘)](#docker--vps-部署)
4. [Railway 部署 (10 分鐘)](#railway-部署)
5. [Agent Runtime 雲端配置](#agent-runtime-雲端配置)
6. [環境變數速查](#環境變數速查)
7. [持久化策略](#持久化策略)
8. [HTTPS 配置](#https-配置)
9. [疑難排解](#疑難排解)

---

## 前置需求

- Git clone of karvi repo
- Docker（用於建構映像檔）
- 部署目標的 CLI 工具：fly CLI / Railway CLI / VPS SSH
- 網域名稱（選用，各平台提供 `*.fly.dev` / `*.railway.app` 免費子網域）

---

## Fly.io 部署

最快的雲端部署方式。Karvi repo 已包含 `Dockerfile` 和 `fly.toml`，一個指令即可部署。

### Step 1: 安裝 fly CLI

```bash
# macOS
brew install flyctl

# Windows
powershell -Command "iwr https://fly.io/install.ps1 -useb | iex"

# Linux
curl -L https://fly.io/install.sh | sh
```

### Step 2: 登入

```bash
fly auth login
```

### Step 3: 建立應用程式（首次）

```bash
cd karvi
fly launch
```

`fly launch` 會自動偵測 `Dockerfile` 和 `fly.toml`，詢問：
- App name（預設 `karvi`，可自訂）
- Region（預設 `nrt` 東京，可改其他區域）
- 是否建立 volume（選 Yes）

> **注意**: 如果 `fly launch` 沒有自動建立 volume，手動建立：
> ```bash
> fly volumes create karvi_data --region nrt --size 1
> ```

### Step 4: 設定 Secrets

```bash
# 必要：API 認證 token
fly secrets set KARVI_API_TOKEN=your-secret-token

# 選用：Vault 加密金鑰（32-byte hex）
fly secrets set KARVI_VAULT_KEY=your-vault-key

# 選用：CORS 白名單
fly secrets set KARVI_CORS_ORIGINS=https://your-app.fly.dev
```

### Step 5: 部署

```bash
fly deploy
```

### Step 6: 驗證

```bash
# 健康檢查
curl https://your-app.fly.dev/health

# 應回傳 {"status":"ok",...}

# SSE 連線測試
curl -N -H "Authorization: Bearer your-secret-token" \
  https://your-app.fly.dev/api/events
```

### 更新部署

```bash
# 拉最新程式碼後重新部署
git pull
fly deploy
```

### 查看日誌

```bash
fly logs
fly logs --app karvi
```

### SSH 進入容器

```bash
fly ssh console
# 查看資料目錄
ls /data
```

---

## Docker + VPS 部署

適合需要完整控制權的使用者，或需要在 VPS 上安裝 agent CLI 工具（openclaw/codex/claude）的場景。

### 方式 A: Docker 容器

#### Step 1: 建構映像檔

```bash
cd karvi
docker build -t karvi .
```

#### Step 2: 啟動容器

```bash
docker run -d \
  --name karvi \
  --restart unless-stopped \
  -p 3461:3461 \
  -v karvi-data:/data \
  -e KARVI_API_TOKEN=your-secret-token \
  -e KARVI_TRUST_PROXY=true \
  karvi
```

#### Step 3: 驗證

```bash
curl http://localhost:3461/health
```

#### Step 4: 設定 HTTPS

使用 Caddy 反向代理，詳見 [deploy.md](deploy.md#正式部署--caddy-反向代理)。

### 方式 B: Docker Compose（含 Caddy）

建立 `docker-compose.yml`：

```yaml
services:
  karvi:
    build: .
    restart: unless-stopped
    volumes:
      - karvi-data:/data
    environment:
      - PORT=3461
      - DATA_DIR=/data
      - KARVI_API_TOKEN=${KARVI_API_TOKEN}
      - KARVI_TRUST_PROXY=true
      - KARVI_CORS_ORIGINS=https://karvi.example.com
    healthcheck:
      test: ["CMD", "node", "-e", "const http=require('http');const r=http.get('http://localhost:3461/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3

  caddy:
    image: caddy:alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config

volumes:
  karvi-data:
  caddy-data:
  caddy-config:
```

```bash
# 建立 .env 檔案
echo "KARVI_API_TOKEN=your-secret-token" > .env

# 啟動
docker compose up -d

# 查看狀態
docker compose ps
docker compose logs -f karvi
```

> **注意**: 記得編輯 `deploy/Caddyfile`，將 `karvi.example.com` 替換為你的網域。

### 方式 C: 直接執行（不用 Docker）

適合需要安裝 agent CLI 工具的 VPS。

#### Step 1: 安裝 Node.js 22

```bash
# Ubuntu/Debian (via NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

#### Step 2: 部署程式碼

```bash
sudo mkdir -p /opt/karvi
cd /opt/karvi
git clone https://github.com/fagemx/karvi.git .
```

#### Step 3: 建立 systemd service

```bash
sudo tee /etc/systemd/system/karvi.service << 'EOF'
[Unit]
Description=Karvi Task Engine
After=network.target

[Service]
Type=simple
User=karvi
Group=karvi
WorkingDirectory=/opt/karvi
ExecStart=/usr/bin/node server/server.js
Restart=on-failure
RestartSec=5

# 環境變數
Environment=PORT=3461
Environment=DATA_DIR=/opt/karvi/data
Environment=NODE_ENV=production
Environment=KARVI_TRUST_PROXY=true
EnvironmentFile=-/etc/karvi.env

# 安全加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/karvi/data

[Install]
WantedBy=multi-user.target
EOF
```

#### Step 4: 建立使用者和資料目錄

```bash
sudo useradd --system --no-create-home karvi
sudo mkdir -p /opt/karvi/data/briefs /opt/karvi/data/vaults
sudo chown -R karvi:karvi /opt/karvi/data
```

#### Step 5: 設定 Secrets

```bash
sudo tee /etc/karvi.env << 'EOF'
KARVI_API_TOKEN=your-secret-token
KARVI_CORS_ORIGINS=https://karvi.example.com
EOF
sudo chmod 600 /etc/karvi.env
```

#### Step 6: 啟動

```bash
sudo systemctl daemon-reload
sudo systemctl enable karvi
sudo systemctl start karvi
sudo systemctl status karvi
```

#### Step 7: 設定 Caddy

參考 [deploy.md](deploy.md#正式部署--caddy-反向代理)。

---

## Railway 部署

Railway 提供 GitHub 整合自動部署。

### Step 1: 連接 GitHub Repo

1. 前往 [railway.app](https://railway.app)
2. New Project → Deploy from GitHub Repo
3. 選擇 `fagemx/karvi`（或你的 fork）

### Step 2: 設定環境變數

在 Railway Dashboard → Variables 中設定：

| 變數 | 值 |
|------|-----|
| `PORT` | `3461` |
| `DATA_DIR` | `/data` |
| `KARVI_API_TOKEN` | `your-secret-token` |
| `KARVI_TRUST_PROXY` | `true` |

### Step 3: 新增 Volume

在 Railway Dashboard → Service → Add Volume：
- Mount path: `/data`

### Step 4: 部署

Railway 會自動偵測 `Dockerfile` 並建構部署。後續每次 push 到 main 分支都會自動部署。

### Step 5: 驗證

```bash
curl https://your-app.railway.app/health
```

> **SSE 注意**: Railway 的 proxy 可能會 buffer SSE 回應。部署後請用 curl 測試 SSE 連線：
> ```bash
> curl -N -H "Authorization: Bearer your-token" \
>   https://your-app.railway.app/api/events
> ```
> 如果 SSE 無法即時收到 heartbeat，建議改用 Fly.io。

---

## Agent Runtime 雲端配置

雲端容器通常不會安裝 openclaw / codex / claude CLI 工具。以下是各 runtime 的雲端適配性：

| Runtime | 需要 CLI? | 雲端可用? | 說明 |
|---------|-----------|-----------|------|
| `openclaw` | 是 | 否 | 需要本地安裝 CLI |
| `codex` | 是 | 否 | 需要本地安裝 CLI |
| `claude` | 是 | 否 | 需要本地安裝 CLI |
| `claude-api` | 否 (HTTP) | 是 | 使用 vault per-user API key |

### 建議：雲端使用 claude-api runtime

`claude-api` runtime 透過 vault 管理 per-user Anthropic API key，不使用全域環境變數。每位使用者需透過 API 將自己的 key 存入 vault：

```bash
# 1. 確保 KARVI_VAULT_KEY 已設定（加密金鑰）
# Fly.io
fly secrets set KARVI_VAULT_KEY=your-32-byte-hex-key

# Docker
docker run -d \
  -e KARVI_VAULT_KEY=your-32-byte-hex-key \
  ... karvi

# 2. 每位使用者透過 API 存入自己的 Anthropic API key
curl -X POST https://your-app.fly.dev/api/vault/store \
  -H 'Authorization: Bearer your-token' \
  -H 'Content-Type: application/json' \
  -d '{"userId": "user1", "key": "anthropic_api_key", "value": "sk-ant-xxx"}'

# 3. 在 board controls 中設定預設 runtime
curl -X POST https://your-app.fly.dev/api/controls \
  -H 'Authorization: Bearer your-token' \
  -H 'Content-Type: application/json' \
  -d '{"preferred_runtime": "claude-api"}'
```

> **注意**: `ANTHROPIC_API_KEY` 環境變數不被 `claude-api` runtime 使用。所有 API key 皆從 vault 按使用者解析（見 `server/runtime-claude-api.js` 的 `resolveApiKey()`）。

### 進階：自訂 Dockerfile 安裝 CLI

如果需要在容器中使用 CLI runtime，可以擴展 Dockerfile：

```dockerfile
FROM node:22-alpine

# 安裝額外工具
RUN apk add --no-cache curl bash

# 安裝 claude CLI（範例）
# RUN npm install -g @anthropic-ai/claude-cli

# Data directory (must run as root before USER node)
RUN mkdir -p /data/briefs /data/vaults && chown -R node:node /data

USER node
WORKDIR /app
COPY --chown=node:node . .
ENV PORT=3461 DATA_DIR=/data NODE_ENV=production
EXPOSE 3461
CMD ["node", "server/server.js"]
```

---

## 環境變數速查

### 核心設定

| 變數 | 說明 | 預設值 | Secret? |
|------|------|--------|---------|
| `PORT` | HTTP 監聽 port | `3461` | 否 |
| `DATA_DIR` | 資料目錄（board.json, logs, briefs） | `server/` | 否 |
| `NODE_ENV` | Node.js 環境 | — | 否 |

### 安全

| 變數 | 說明 | 預設值 | Secret? |
|------|------|--------|---------|
| `KARVI_API_TOKEN` | Bearer token 驗證 | 無（停用驗證） | **是** |
| `KARVI_VAULT_KEY` | Vault 加密金鑰（32-byte hex） | 無 | **是** |
| `KARVI_CORS_ORIGINS` | CORS 允許來源，逗號分隔 | `*` | 否 |
| `KARVI_TRUST_PROXY` | 信任反向代理 IP headers | `false` | 否 |

### 流量控制

| 變數 | 說明 | 預設值 | Secret? |
|------|------|--------|---------|
| `KARVI_RATE_LIMIT` | 每 IP 每分鐘最大請求數 | `120` | 否 |
| `KARVI_MAX_BODY` | POST body 大小上限 (bytes) | `1048576` | 否 |
| `KARVI_SSE_LIMIT` | SSE 最大同時連線數 | `50` | 否 |

### 整合

| 變數 | 說明 | 預設值 | Secret? |
|------|------|--------|---------|
| `JIRA_HOST` | Jira instance hostname | 無 | 否 |
| `JIRA_EMAIL` | Jira auth email | 無 | 否 |
| `JIRA_API_TOKEN` | Jira API token | 無 | **是** |
| `JIRA_WEBHOOK_SECRET` | Jira webhook 簽名驗證密鑰 | 無 | **是** |

### 進階

| 變數 | 說明 | 預設值 | Secret? |
|------|------|--------|---------|
| `KARVI_STORAGE` | Storage backend (`json`/`sqlite`) | `json` | 否 |
| `KARVI_TELEMETRY` | Opt-out（設 `0`/`off`/`false`/`no`） | 啟用 | 否 |
| `KARVI_PORT_MIN` | Gateway instance port range start | — | 否 |
| `KARVI_PORT_MAX` | Gateway instance port range end | — | 否 |

> **標記為 Secret 的變數**應使用平台的 secret 管理功能（`fly secrets set`、Railway Variables、systemd EnvironmentFile），不要寫在 Dockerfile 或 fly.toml 中。

---

## 持久化策略

### 需要持久化的檔案

所有檔案位於 `DATA_DIR` 目錄下：

| 檔案 | 用途 | 重要性 |
|------|------|--------|
| `board.json` | 任務板（single source of truth） | 必要 |
| `board.json.bak` | 原子寫入備份 | 建議保留 |
| `task-log.jsonl` | 事件紀錄（append-only） | 建議保留 |
| `briefs/*.json` | Scoped brief 檔案 | 選用 |
| `vaults/*.vault.json` | 加密 vault 資料 | 必要 |
| `push-tokens.json` | Push notification tokens | 選用 |

### 各平台 Volume 配置

| 平台 | Volume 方式 | 掛載路徑 |
|------|-------------|----------|
| Fly.io | `fly volumes create karvi_data` | `/data` |
| Docker | `-v karvi-data:/data` | `/data` |
| Docker Compose | Named volume `karvi-data` | `/data` |
| Railway | Dashboard → Add Volume | `/data` |
| VPS (直接) | 目錄 `/opt/karvi/data/` | N/A |

### 備份策略

#### Fly.io

```bash
# SSH 進入後打包
fly ssh console -C "tar czf /tmp/karvi-backup.tar.gz -C /data ."

# 下載到本地
fly ssh sftp get /tmp/karvi-backup.tar.gz ./karvi-backup.tar.gz
```

#### Docker / VPS

```bash
# 從 Docker volume 備份
docker run --rm -v karvi-data:/data -v $(pwd):/backup \
  alpine tar czf /backup/karvi-backup.tar.gz -C /data .

# VPS 直接備份
tar czf ~/karvi-backup-$(date +%Y%m%d).tar.gz -C /opt/karvi/data .
```

#### 定時自動備份（VPS）

```bash
# crontab -e
0 3 * * * tar czf /backups/karvi-$(date +\%Y\%m\%d).tar.gz -C /opt/karvi/data .
```

---

## HTTPS 配置

| 平台 | HTTPS 方式 | 設定 |
|------|------------|------|
| Fly.io | 自動（`force_https = true`） | 無需額外設定 |
| Railway | 自動（`*.railway.app`） | 無需額外設定 |
| VPS + Caddy | 自動 Let's Encrypt | 見 [deploy.md](deploy.md#正式部署--caddy-反向代理) |
| VPS + Cloudflare Tunnel | Cloudflare 管理 | 見 [deploy.md](deploy.md#快速上手--cloudflare-tunnel) |

> **自訂網域**: Fly.io 和 Railway 都支援自訂網域 + 自動 TLS。參考各平台文件設定 CNAME 記錄。

---

## 疑難排解

### Container 啟動但 /health 回傳錯誤

**症狀**: 容器 running 但 health check 失敗

**排查**:
```bash
# 檢查容器日誌
docker logs karvi
# 或
fly logs

# 確認 PORT 設定正確
# 確認 DATA_DIR 目錄存在且有寫入權限
```

### Volume 資料未持久化

**症狀**: 重啟後 board.json 遺失

**可能原因**: 未正確掛載 volume

**排查**:
```bash
# Docker — 確認 volume 存在
docker volume ls | grep karvi

# Fly.io — 確認 volume 存在
fly volumes list

# 檢查掛載
docker inspect karvi | grep -A5 Mounts
```

### SSE 連線在 PaaS 上斷開

**症狀**: EventSource 連線頻繁斷開

**可能原因**: 平台 proxy 啟用了 response buffering 或 idle timeout 太短

**解法**:
1. Fly.io: `fly.toml` 中已設定 `auto_stop_machines = "off"`，通常無問題
2. Railway: 確認 SSE heartbeat（30 秒）正常接收
3. 通用: 在瀏覽器 DevTools → Network → 篩選 EventStream 確認

```bash
# 測試 SSE 連線
curl -N -H "Authorization: Bearer your-token" \
  https://your-app.fly.dev/api/events
# 應立即看到 event: connected
# 每 30 秒收到 : heartbeat
```

### CORS 錯誤（自訂網域）

**症狀**: 瀏覽器 console 出現 `Access-Control-Allow-Origin` 錯誤

**解法**:
```bash
# 設定 CORS 白名單
fly secrets set KARVI_CORS_ORIGINS=https://your-domain.com

# 多個來源
fly secrets set KARVI_CORS_ORIGINS=https://your-domain.com,https://your-app.fly.dev
```

### 記憶體 / CPU 大小建議

| 使用場景 | 建議配置 |
|----------|----------|
| 個人使用（< 10 tasks） | 256MB RAM, shared CPU |
| 小團隊（< 100 tasks） | 512MB RAM, shared CPU |
| 中型使用（< 1000 tasks） | 1GB RAM, dedicated CPU |

> **Note**: Karvi 使用 JSON 檔案儲存，記憶體需求隨 `board.json` 大小線性增長。大量 tasks 時建議關注 `board.json` 檔案大小，未來可透過 storage abstraction (#37) 遷移至 SQLite/Postgres。
