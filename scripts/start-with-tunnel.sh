#!/usr/bin/env bash
# start-with-tunnel.sh — Start Karvi + Cloudflare Tunnel in one command
#
# Usage:
#   bash scripts/start-with-tunnel.sh                        # default settings
#   KARVI_API_TOKEN=xxx bash scripts/start-with-tunnel.sh    # with pre-set token
#   PORT=8080 bash scripts/start-with-tunnel.sh              # custom port
#
# Prerequisites:
#   - Node.js 22+ (node)
#   - cloudflared (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

set -euo pipefail

# ── Check prerequisites ──────────────────────────────────────────────────────

command -v node >/dev/null 2>&1 || {
  echo "Error: node not found. Install Node.js 22+."
  echo "  macOS:  brew install node@22"
  echo "  Linux:  https://nodejs.org/en/download"
  echo "  Windows: winget install OpenJS.NodeJS.LTS"
  exit 1
}

command -v cloudflared >/dev/null 2>&1 || {
  echo "Error: cloudflared not found."
  echo "  macOS:  brew install cloudflared"
  echo "  Linux:  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  echo "  Windows: winget install Cloudflare.cloudflared"
  exit 1
}

# ── Configuration ─────────────────────────────────────────────────────────────

PORT="${PORT:-3461}"

# Auto-generate token if not set
if [ -z "${KARVI_API_TOKEN:-}" ]; then
  KARVI_API_TOKEN=$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")
  export KARVI_API_TOKEN
  echo "========================================"
  echo "  Generated API token:"
  echo "  $KARVI_API_TOKEN"
  echo ""
  echo "  Save this token — you need it for"
  echo "  phone/remote access."
  echo "========================================"
  echo ""
fi

# ── Start Karvi in background ─────────────────────────────────────────────────

echo "Starting Karvi on port $PORT..."
KARVI_API_TOKEN="$KARVI_API_TOKEN" PORT="$PORT" node server/server.js &
SERVER_PID=$!

# ── Cleanup on exit ───────────────────────────────────────────────────────────

cleanup() {
  echo ""
  echo "Stopping Karvi (PID $SERVER_PID)..."
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  echo "Done."
}
trap cleanup EXIT INT TERM

# ── Wait for server to be ready ───────────────────────────────────────────────

sleep 2
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "Error: Karvi failed to start. Check the output above."
  exit 1
fi

echo "Karvi is running. Starting Cloudflare Tunnel..."
echo "Press Ctrl+C to stop both server and tunnel."
echo ""

# ── Start tunnel (foreground — Ctrl+C stops everything) ───────────────────────

cloudflared tunnel --url "http://localhost:${PORT}"
