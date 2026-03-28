#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  "$ROOT_DIR/scripts/bootstrap.sh"
fi

cd "$ROOT_DIR/frontend"
npm run build

cd "$ROOT_DIR"
exec "$ROOT_DIR/.venv/bin/python" -m backend.main
