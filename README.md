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

## Layout

- `backend/` FastAPI application, persistence, transcription, summarization, report export
- `frontend/` React + Vite PWA
- `data/` runtime storage for SQLite, settings, and audio files
- `deploy/brainsession-pwa.service` systemd user service example

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

## Notes

- Voice transcription uses the browser microphone and uploads audio only after recording stops.
- Audio files are stored under `data/media/notes/...`.
- API key and model settings are stored on the server side in `data/settings.json`.
