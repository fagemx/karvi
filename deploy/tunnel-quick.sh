#!/usr/bin/env bash
# tunnel-quick.sh — One-command Cloudflare Tunnel for Karvi
#
# Creates an anonymous tunnel to expose localhost:3461 over HTTPS.
# No Cloudflare account needed. URL is random and temporary.
#
# Usage:
#   bash deploy/tunnel-quick.sh              # default port 3461
#   bash deploy/tunnel-quick.sh 8080         # custom port
#
# Prerequisites:
#   - cloudflared installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
#   - Karvi server running on the target port

set -euo pipefail

PORT="${1:-3461}"

if ! command -v cloudflared &>/dev/null; then
  echo "Error: cloudflared is not installed."
  echo "Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
  exit 1
fi

echo "Starting Cloudflare Tunnel → http://localhost:${PORT}"
echo "Press Ctrl+C to stop."
echo ""

cloudflared tunnel --url "http://localhost:${PORT}"
