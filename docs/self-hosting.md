# Self-Hosting Guide

> **Route A**: Run Karvi on your desktop, expose via tunnel, access from your phone.
> Zero cost, 10-minute setup, no server or VPS needed.

## TL;DR

**macOS / Linux:**
```bash
git clone https://github.com/fagemx/karvi.git && cd karvi
bash scripts/start-with-tunnel.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/fagemx/karvi.git; cd karvi
.\scripts\start-with-tunnel.ps1
```

The script starts Karvi, auto-generates an API token, and opens a Cloudflare Tunnel.
Copy the printed HTTPS URL and open it on your phone.

---

## What You'll Get

```
┌──────────┐     ┌──────────────┐     ┌────────────────────┐     ┌──────────┐
│  Phone   │────>│  Cloudflare  │────>│  Your Desktop      │     │  Agents  │
│  Browser │     │  Tunnel      │     │  Karvi :3461       │<────│ OpenClaw │
└──────────┘     │  (HTTPS)     │     │  board.json        │     │ Claude   │
                 └──────────────┘     └────────────────────┘     └──────────┘
```

Cloudflare Tunnel creates an encrypted connection from your machine to Cloudflare's
edge network. No port forwarding needed, no public IP required, automatic HTTPS.
The anonymous tunnel URL is long and random — effectively unguessable.

---

## Step 1: Install Prerequisites

### Node.js 22+

| Platform | Command |
|----------|---------|
| Windows | `winget install OpenJS.NodeJS.LTS` |
| macOS | `brew install node@22` |
| Linux (Ubuntu/Debian) | See [nodejs.org/download](https://nodejs.org/en/download) |

Verify:
```bash
node --version
# Should print v22.x.x or higher
```

### cloudflared

| Platform | Command |
|----------|---------|
| Windows | `winget install Cloudflare.cloudflared` |
| macOS | `brew install cloudflared` |
| Linux | See [official downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) |

Verify:
```bash
cloudflared --version
```

---

## Step 2: Get Karvi

```bash
git clone https://github.com/fagemx/karvi.git
cd karvi
```

> No `npm install` needed — Karvi has zero external dependencies.

---

## Step 3: Generate an API Token

Without a token, anyone with the tunnel URL can read and write your board.
**Always set a token when exposing Karvi over a tunnel.**

| Platform | Command |
|----------|---------|
| macOS / Linux | `export KARVI_API_TOKEN=$(openssl rand -hex 16)` |
| Windows (PowerShell) | `$env:KARVI_API_TOKEN = -join ((1..32) \| ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })` |
| Any (Node.js one-liner) | `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"` |

Print and save the token:
```bash
# macOS / Linux
echo $KARVI_API_TOKEN

# Windows (PowerShell)
echo $env:KARVI_API_TOKEN
```

> If you use the start-with-tunnel scripts (Step 5), the token is auto-generated
> when `KARVI_API_TOKEN` is not set. The script prints it so you can save it.

---

## Step 4: Start Karvi

```bash
# macOS / Linux
KARVI_API_TOKEN=$KARVI_API_TOKEN npm start

# Windows (PowerShell) — env var already set in Step 3
npm start
```

Verify the server is running:

```bash
curl http://localhost:3461/health
# Should return {"status":"ok",...}
```

Windows (PowerShell, no curl):
```powershell
Invoke-RestMethod http://localhost:3461/health
```

---

## Step 5: Start the Tunnel

### Option A: Use the script (recommended)

The script starts both the server and the tunnel in one command. If you already
started the server in Step 4, stop it first (Ctrl+C), then run:

```bash
# macOS / Linux
bash scripts/start-with-tunnel.sh
```

```powershell
# Windows (PowerShell)
.\scripts\start-with-tunnel.ps1
```

The script will:
1. Check that `node` and `cloudflared` are installed
2. Generate an API token if `KARVI_API_TOKEN` is not set
3. Start Karvi in the background
4. Start the tunnel in the foreground
5. Clean up the server process when you press Ctrl+C

### Option B: Manual tunnel

If Karvi is already running (from Step 4), open a new terminal and run:

```bash
cloudflared tunnel --url http://localhost:3461
```

The output will show:
```
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://random-word-1234.trycloudflare.com
```

Copy this URL — this is your phone access point.

---

## Step 6: Connect Your Phone

1. Open your phone's browser
2. Navigate to the tunnel URL (e.g. `https://random-word-1234.trycloudflare.com`)
3. The Karvi board should load with real-time updates via SSE

The web UI served through the tunnel works directly — static files do not require
authentication. API calls from the UI will use the token configured in the UI's
settings panel.

---

## Step 7: Keep Running (Optional)

For users who want Karvi to survive closing the terminal.

### Linux (systemd)

Create `/etc/systemd/system/karvi.service`:
```ini
[Unit]
Description=Karvi Task Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/user/karvi
Environment=KARVI_API_TOKEN=your-token-here
Environment=PORT=3461
ExecStart=/usr/bin/node server/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now karvi
```

### macOS (launchd)

Create `~/Library/LaunchAgents/com.karvi.server.plist` — see the
[Apple launchd documentation](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
for the plist format. Key fields: `ProgramArguments`, `WorkingDirectory`,
`EnvironmentVariables`, `KeepAlive`.

### Windows (Task Scheduler)

1. Open Task Scheduler
2. Create Basic Task > name it "Karvi"
3. Trigger: At Startup
4. Action: Start a Program > `node` with arguments `server\server.js`
5. Set "Start in" to your karvi directory

Alternatively, use [nssm](https://nssm.cc/) to install as a Windows service:
```cmd
nssm install karvi node server\server.js
nssm set karvi AppDirectory C:\path\to\karvi
nssm set karvi AppEnvironmentExtra KARVI_API_TOKEN=your-token-here
nssm start karvi
```

---

## Security Notes

- **Anonymous tunnel URL** is long and random (effectively unguessable) but
  changes on every restart of cloudflared.
- **API token is your primary security layer** — always set `KARVI_API_TOKEN`
  when exposing Karvi over a tunnel.
- **Tunnel traffic is encrypted** end-to-end (HTTPS between phone and Cloudflare,
  encrypted connection between Cloudflare and your machine).
- For a **persistent fixed URL**, set up a Named Tunnel with a custom domain.
  See `deploy/cloudflared.yml` for a template.
- For **VPS / cloud deployment** with Caddy reverse proxy, see
  [Deployment Guide](deploy.md).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cloudflared: command not found` | Install cloudflared (see [Step 1](#step-1-install-prerequisites)) |
| `node: command not found` | Install Node.js 22+ (see [Step 1](#step-1-install-prerequisites)) |
| `EADDRINUSE: port 3461` | Another process is using port 3461. Kill it, or use a different port: `PORT=3462 npm start` |
| Tunnel starts but page won't load | Confirm Karvi is running: `curl http://localhost:3461/health` |
| SSE disconnects frequently | Check [Deployment Guide — Troubleshooting](deploy.md#疑難排解) |
| Phone can't reach tunnel URL | Tunnel goes through the internet (same network not required). Wait 30 seconds for DNS propagation after tunnel starts. |
| Windows: "running scripts is disabled" | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in PowerShell |
| Windows: PowerShell script won't run | Ensure you run from the repo root: `cd karvi; .\scripts\start-with-tunnel.ps1` |

---

## Next Steps

- **Fixed URL** — Set up a [Named Tunnel](deploy.md#named-tunnel-固定-url) for a
  permanent domain that doesn't change on restart.
- **VPS / Cloud deployment** — See the [Deployment Guide](deploy.md) for
  production setup with Caddy reverse proxy and custom domain.
- **Production hardening** — Configure `KARVI_CORS_ORIGINS`, rate limiting, and
  proxy trust settings. See [Environment Variables](deploy.md#環境變數參考).
