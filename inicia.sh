#!/usr/bin/env bash
# inicia.sh — Start the TETRIS dev server (zero dependencies) on localhost:3000.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found. Install it from https://nodejs.org and try again." >&2
  exit 1
fi

echo "Starting TETRIS dev server on http://localhost:${PORT}/ ..."
echo "Open that URL in your browser. Press Ctrl+C here to stop."
exec node server.js
