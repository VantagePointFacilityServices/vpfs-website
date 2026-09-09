#!/usr/bin/env bash
# Serves the vpfs-website site locally (with live reload).
# Usage: ./serve.sh [port]   (defaults to 8124)
set -euo pipefail
PORT="${1:-8124}"
cd "$(dirname "$0")/site"
exec node dev-server.js "$PORT"
