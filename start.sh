#!/bin/bash
# Start GT WebUI server
# Run from ~/gt directory with: bash gt-webui/start.sh

cd "$(dirname "$0")"
export GT_DIR="${GT_DIR:-$HOME/gt}"
export PATH="$HOME/go/bin:$PATH"

echo "Starting GT WebUI..."
echo "GT Directory: $GT_DIR"
echo "Dashboard: http://localhost:${PORT:-3000}"

node server.js
