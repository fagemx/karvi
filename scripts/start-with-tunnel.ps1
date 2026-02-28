# start-with-tunnel.ps1 — Start Karvi + Cloudflare Tunnel (Windows)
#
# Usage:
#   .\scripts\start-with-tunnel.ps1
#   $env:KARVI_API_TOKEN = "xxx"; .\scripts\start-with-tunnel.ps1
#   $env:PORT = "8080"; .\scripts\start-with-tunnel.ps1
#
# Prerequisites:
#   - Node.js 22+ (winget install OpenJS.NodeJS.LTS)
#   - cloudflared  (winget install Cloudflare.cloudflared)

$ErrorActionPreference = "Stop"

# ── Check prerequisites ──────────────────────────────────────────────────────

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "node not found. Install Node.js 22+: winget install OpenJS.NodeJS.LTS"
    exit 1
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Error "cloudflared not found. Install: winget install Cloudflare.cloudflared"
    exit 1
}

# ── Configuration ─────────────────────────────────────────────────────────────

$Port = if ($env:PORT) { $env:PORT } else { "3461" }

# Auto-generate token if not set
if (-not $env:KARVI_API_TOKEN) {
    $bytes = New-Object byte[] 16
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $env:KARVI_API_TOKEN = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Generated API token:" -ForegroundColor Cyan
    Write-Host "  $env:KARVI_API_TOKEN" -ForegroundColor Yellow
    Write-Host "" -ForegroundColor Cyan
    Write-Host "  Save this token — you need it for" -ForegroundColor Cyan
    Write-Host "  phone/remote access." -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
}

# ── Start Karvi in background ─────────────────────────────────────────────────

Write-Host "Starting Karvi on port $Port..."

$env:PORT = $Port
$serverProcess = Start-Process -FilePath "node" -ArgumentList "server/server.js" `
    -PassThru -NoNewWindow

Start-Sleep -Seconds 2

if ($serverProcess.HasExited) {
    Write-Error "Karvi failed to start. Check the output above."
    exit 1
}

Write-Host "Karvi is running (PID: $($serverProcess.Id)). Starting Cloudflare Tunnel..."
Write-Host "Press Ctrl+C to stop both server and tunnel."
Write-Host ""

# ── Start tunnel (foreground — Ctrl+C stops everything) ───────────────────────

try {
    cloudflared tunnel --url "http://localhost:$Port"
}
finally {
    Write-Host ""
    Write-Host "Stopping Karvi (PID: $($serverProcess.Id))..."
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
    Write-Host "Done."
}
