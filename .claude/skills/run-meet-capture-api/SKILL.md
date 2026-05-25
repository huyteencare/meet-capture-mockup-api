---
name: run-meet-capture-api
description: run, start, launch, smoke-test, verify, screenshot meet-capture-api server
---

meet-capture-api is a Node.js (Express) HTTP server that receives Google Meet capture events from a browser extension and stores them as JSON on disk (and optionally uploads to GCS/Supabase). The driver is a bash smoke script that starts the server and curls every route.

## Prerequisites

```bash
node --version   # >=20 required
npm install      # installs express, googleapis, @google-cloud/storage, supertest
```

No cloud credentials are needed to run locally. The server starts without them; the `/api/capture/presign` endpoint returns `503 Storage not configured`, which is expected.

## Run (agent path)

```bash
bash .claude/skills/run-meet-capture-api/smoke.sh
```

The script:
1. Starts the server on `127.0.0.1:18787` (`STORAGE_PROVIDER=gcs`, no key file)
2. Waits up to 4 s for `/health` to respond
3. Exercises all five routes in order:
   - `GET /health` → `{"ok":true}`
   - `POST /api/capture/batch` → saves 1 event to `captures/smoke-driver-mtg/smoke-driver-sess/`
   - `GET /api/sessions` → lists all sessions
   - `GET /api/sessions/smoke-driver-sess` → returns session detail + manifest
   - `POST /api/capture/presign` → `503 Storage not configured` (correct without creds)
4. Kills the server and deletes `captures/smoke-driver-mtg/` and `benchmark-*.csv`
5. Exits 0 on pass, 1 on failure

## Run (human path)

```bash
PORT=8787 HOST=0.0.0.0 node --env-file=.env src/server.js
```

Requires a `.env` with at least `STORAGE_PROVIDER` set. See `.env.example` for all vars.

## Tests

```bash
node --test tests/
```

18 tests, ~600 ms. No `.env` needed — tests spin up `createApp()` directly.

## Gotchas

- **`--env-file=.env` crashes if `.env` is missing.** The smoke script bypasses this by setting env vars inline — never use `npm start` in CI or agent contexts without the file.
- **`/api/sessions/:sessionId` takes the raw `sessionId` field**, not `meetingId/sessionId`. Pass just `smoke-driver-sess`, not `smoke-driver-mtg/smoke-driver-sess`.
- **`benchmark-*.csv` is written by the server on every start** in the project root. The smoke script deletes it on exit; manual runs accumulate them.
- **Captures data is under `captures/` relative to wherever you start the server** (not the script's `$PWD`). Run from the repo root.
