#!/usr/bin/env bash
# PayNGo one-shot launcher: starts MongoDB (if needed) + web UI + camera app,
# and stops everything when you quit the camera app (press q or Ctrl+C).
#
# Usage:
#   ./dev.sh                     # MongoDB + web UI + camera app (--display)
#   ./dev.sh --camera 1          # extra args are passed to smart_shelf.py
#   ./dev.sh --no-mongo          # skip MongoDB entirely
set -euo pipefail
cd "$(dirname "$0")"

SKIP_MONGO=false
for arg in "$@"; do
  if [ "$arg" = "--no-mongo" ]; then SKIP_MONGO=true; fi
done

# --- 1. MongoDB ---------------------------------------------------------------
if [ "$SKIP_MONGO" = false ]; then
  if ! pgrep -x mongod >/dev/null 2>&1; then
    echo "[payngo] Starting MongoDB..."
    brew services start mongodb-community >/dev/null
  fi
  for _ in $(seq 1 60); do
    if mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! mongosh --quiet --eval 'db.runCommand({ping:1})' >/dev/null 2>&1; then
    echo "[payngo] ERROR: MongoDB did not become ready" >&2
    exit 1
  fi
  echo "[payngo] MongoDB up (localhost:27017)"
fi

# --- 2. Web UI ------------------------------------------------------------------
if [ ! -d web/node_modules ]; then
  echo "[payngo] Installing web dependencies (first run)..."
  (cd web && npm install)
fi
echo "[payngo] Web UI starting -> http://localhost:3000"
(cd web && npm run dev) &
WEB_PID=$!

# Kill the npm wrapper *and* its descendants (next-server) on exit.
kill_tree() {
  local pid kids
  kids=$(pgrep -P "$1" 2>/dev/null || true)
  for k in $kids; do kill_tree "$k"; done
  kill "$1" 2>/dev/null || true
}
cleanup() {
  kill_tree "$WEB_PID"
  [ -n "${CAMERA_PID:-}" ] && kill_tree "$CAMERA_PID"
  return 0
}
trap cleanup EXIT INT TERM

# --- 3. Camera app ------------------------------------------------------------
if [ ! -d venv ]; then
  echo "[payngo] Creating Python venv (first run)..."
  python3 -m venv venv
  ./venv/bin/pip install -q -r requirements.txt
fi
source venv/bin/activate
echo "[payngo] Starting camera app..."
python smart_shelf.py --display "$@" &
CAMERA_PID=$!
wait "$CAMERA_PID"
