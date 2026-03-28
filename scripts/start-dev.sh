#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  "$ROOT_DIR/scripts/bootstrap.sh"
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT

cd "$ROOT_DIR/frontend"
npm run dev &
FRONTEND_PID=$!

cd "$ROOT_DIR"
"$ROOT_DIR/.venv/bin/python" -m backend.main &
BACKEND_PID=$!

wait "$FRONTEND_PID"
