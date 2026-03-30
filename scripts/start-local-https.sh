#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/bootstrap.sh"

cd "$ROOT_DIR/frontend"
npm run build

cd "$ROOT_DIR"
eval "$("$ROOT_DIR/.venv/bin/python" "$ROOT_DIR/scripts/local_https.py")"

echo "Local test CA: $ROOT_CA_CERT"
echo "Open this on Android Chrome after installing the CA: $HTTPS_URL"
echo "If your phone needs a different laptop IP, set BRAINSESSION_HTTPS_IPS before starting."

exec env HOST=0.0.0.0 PORT=8443 SSL_CERTFILE="$SERVER_CERT" SSL_KEYFILE="$SERVER_KEY" "$ROOT_DIR/.venv/bin/python" -m backend.main
