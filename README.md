# Meet Capture API

Local Express API for receiving Chrome extension capture batches and writing them to local files.

## Run

```bash
npm install
npm start
```

Default URL:

```text
http://127.0.0.1:8787
```

Health check:

```bash
curl http://localhost:8787/health
```

## Endpoints

- `GET /health`
- `POST /api/capture/batch`
- `GET /api/sessions`
- `GET /api/sessions/:sessionId`
- `GET /captures/*`

## Storage

Captured files are written under:

```text
captures/{meetingId}/{sessionId}/
```

Expected files:

- `manifest.json`
- `frames/*.jpg`
- `frames/*.rgba`
- `audio/*.json`
- `audio/*.f32`
- `recordings/*.webm`

This is intentionally local-only for the PoC. S3 upload can be added after the extension-to-API path is verified.

Current contract is mentor-side:

- `meetingId`
- `sessionId`
- `captureRole`
- `mentorLabel`
- `capturedParticipants`
- `trackStats`
- `events`
