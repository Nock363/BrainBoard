#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTTPS_PORT="${BRAINSESSION_HTTPS_PORT:-8443}"
HTTP_PORT="${PORT:-8000}"
TLS_DIR="${BRAINSESSION_TLS_DIR:-$ROOT_DIR/data/tls}"
CLOUDFLARED_DIR="$ROOT_DIR/.cache/cloudflared"

if [[ ! -x "$ROOT_DIR/.venv/bin/python" ]]; then
  "$ROOT_DIR/scripts/bootstrap.sh"
fi

cd "$ROOT_DIR/frontend"
npm run build

mkdir -p "$TLS_DIR" "$CLOUDFLARED_DIR"

cleanup() {
  if [[ "${BACKEND_STARTED:-0}" == "1" && -n "${BACKEND_PID:-}" ]]; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

dns_name=""
if command -v tailscale >/dev/null 2>&1; then
  dns_name="$(python3 - <<'PY'
import json
import subprocess
try:
    data = json.loads(subprocess.check_output(['tailscale', 'status', '--json'], text=True))
except Exception:
    raise SystemExit(0)
dns_name = str(data.get('Self', {}).get('DNSName', '')).strip().rstrip('.')
if dns_name:
    print(dns_name)
PY
  )"
fi

if [[ -n "$dns_name" ]]; then
  cert_file="$TLS_DIR/$dns_name.crt"
  key_file="$TLS_DIR/$dns_name.key"
  if tailscale cert --cert-file "$cert_file" --key-file "$key_file" "$dns_name" >/dev/null 2>&1; then
    echo "Using trusted Tailscale certificate: https://$dns_name:$HTTPS_PORT"
    cd "$ROOT_DIR"
    exec env HOST=0.0.0.0 PORT="$HTTPS_PORT" SSL_CERTFILE="$cert_file" SSL_KEYFILE="$key_file" "$ROOT_DIR/.venv/bin/python" -m backend.main
  fi
fi

cloudflared_bin=""
if command -v cloudflared >/dev/null 2>&1; then
  cloudflared_bin="$(command -v cloudflared)"
else
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset="cloudflared-linux-amd64" ;;
    aarch64|arm64) asset="cloudflared-linux-arm64" ;;
    armv7l|armv6l) asset="cloudflared-linux-arm" ;;
    *)
      echo "Unsupported architecture for cloudflared fallback: $arch" >&2
      exit 1
      ;;
  esac
  cloudflared_bin="$CLOUDFLARED_DIR/cloudflared"
  if [[ ! -x "$cloudflared_bin" ]]; then
    url="https://github.com/cloudflare/cloudflared/releases/latest/download/$asset"
    echo "Downloading cloudflared fallback from $url"
    curl -fsSL "$url" -o "$cloudflared_bin"
    chmod +x "$cloudflared_bin"
  fi
fi

echo "Tailscale cert access is unavailable; falling back to Cloudflare Quick Tunnel."
echo "Local backend: http://127.0.0.1:$HTTP_PORT"

cd "$ROOT_DIR"
if curl -fsS "http://127.0.0.1:$HTTP_PORT/api/health" >/dev/null 2>&1; then
  echo "Reusing the backend already listening on 127.0.0.1:$HTTP_PORT"
else
  HOST=127.0.0.1 PORT="$HTTP_PORT" "$ROOT_DIR/.venv/bin/python" -m backend.main &
  BACKEND_PID=$!
  BACKEND_STARTED=1

  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$HTTP_PORT/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

exec "$cloudflared_bin" tunnel --no-autoupdate --url "http://127.0.0.1:$HTTP_PORT"
