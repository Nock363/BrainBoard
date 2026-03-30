# BrainSession PWA

Standalone BrainSession web/PWA replacement with:

- voice notes recorded in the browser
- text note creation
- note feed and note detail flow
- timeline entries with voice/text distinction
- note summaries with dynamic sections
- follow-up question review via long-press
- delete confirmations and loading overlays
- durable persistence in SQLite + filesystem audio storage
- PWA install support for iPhone/iOS
- installable HTTPS deployment for Android/iPhone

## Layout

- `backend/` FastAPI application, persistence, transcription, summarization, report export
- `frontend/` React + Vite PWA
- `data/` runtime storage for SQLite, settings, and audio files
- `deploy/brainsession-pwa.service` systemd user service example
- `deploy/brainsession-pwa-https.service` HTTPS/systemd example with trusted-certificate fallback

## Local setup

1. Copy env vars:

```bash
cp .env.example .env
```

2. Install backend dependencies:

```bash
./scripts/bootstrap.sh
```

3. Install frontend dependencies:

```bash
cd frontend
npm install
```

4. Build the frontend:

```bash
npm run build
```

5. Start the backend:

```bash
cd ..
./.venv/bin/python -m backend.main
```

The app serves on `http://localhost:8000`.

## HTTPS install mode

To make the app installable as a real PWA on Android and iPhone, start it through the HTTPS launcher:

```bash
./scripts/start-https.sh
```

The script tries the preferred Tailscale certificate path first. If local Tailscale cert issuance is allowed, it serves the app directly at:

```text
https://nixos.tail615dad.ts.net:8443
```

If Tailscale cert access is blocked, it automatically falls back to a trusted Cloudflare Quick Tunnel and prints the generated `https://...trycloudflare.com` URL in the terminal.

For a persistent service, install `deploy/brainsession-pwa-https.service` as a `systemd --user` unit instead of the HTTP-only unit.

On Android, open the HTTPS URL in Chrome and use the install prompt or menu item. On iPhone, open the same URL in Safari and use Share → Add to Home Screen.

## Local trusted test certificate

If you want a certificate that behaves like a real trusted HTTPS site for device testing, use the local CA launcher:

```bash
./scripts/start-local-https.sh
```

This creates a local root CA and a server certificate under `data/tls/local-test/`, then serves the app on `https://<your-laptop-ip>:8443`.

To trust it on Android, copy `data/tls/local-test/root-ca.crt` to the phone and install it as a CA certificate in Android settings. Then open the printed `https://...:8443` URL in Chrome and allow the microphone permission once.

If the script detects the wrong IP, set `BRAINSESSION_HTTPS_IPS=192.168.1.23` (or your current laptop IP) before starting it again.

## Dev mode

Run the frontend dev server in one terminal:

```bash
cd frontend
npm run dev
```

Run the backend in another terminal:

```bash
cd ..
./.venv/bin/python -m backend.main
```

The Vite dev server proxies `/api` and `/media` to the backend.

## Keeping the server alive

The repo includes `deploy/brainsession-pwa.service`, a `systemd --user` unit that restarts the backend automatically.

Typical flow:

```bash
cp deploy/brainsession-pwa.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now brainsession-pwa.service
```

The unit runs `scripts/start-prod.sh`, which builds the frontend and starts the FastAPI server with `Restart=always`.

## Tailscale exposure

After the service is running, expose it with Tailscale using the local server port:

```bash
tailscale serve --bg http://127.0.0.1:8000
```

If Serve is disabled on the tailnet, enable it from the admin prompt Tailscale prints first:

- Serve: `https://login.tailscale.com/f/serve?node=nqR9gKzcfD11CNTRL`
- Funnel: `https://login.tailscale.com/f/funnel?node=nqR9gKzcfD11CNTRL`

Once enabled, open the generated `https://<machine>.<tailnet>.ts.net` URL on iPhone/iOS.

If local cert issuance is permitted, `scripts/start-https.sh` uses a trusted Tailscale certificate directly and bypasses Serve/Funnel entirely.

## Notes

- Voice transcription uses the browser microphone and uploads audio only after recording stops.
- Audio files are stored under `data/media/notes/...`.
- API key and model settings are stored on the server side in `data/settings.json`.
- Microphone recording only works in a secure context, so use `https://...` or `http://localhost` in Chrome.
