# Deployment & Operations

**Server:** `160.191.244.71` (VPS)
**SSH key:** `~/.ssh/id_ed25519`
**Deploy path:** `/home/projects/meet-capture-api/`

## SSH into server

```bash
ssh -i ~/.ssh/id_ed25519 root@160.191.244.71
```

## Redeploy after local changes

Run from your local machine:

```bash
rsync -avz --progress \
  --exclude='node_modules' \
  --exclude='captures' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='.git' \
  --exclude='reports' \
  --exclude='benchmark-*.csv' \
  --exclude='benchmark-viewer.html' \
  -e "ssh -i ~/.ssh/id_ed25519" \
  /home/huy/workspace/teencare/meet-capture-api/ \
  root@160.191.244.71:/home/projects/meet-capture-api/

ssh -i ~/.ssh/id_ed25519 root@160.191.244.71 "pm2 restart meet-capture-api"
```

## PM2 — process management

```bash
pm2 status                     # check if running
pm2 logs meet-capture-api      # live request logs (morgan + errors)
pm2 logs meet-capture-api --lines 200   # last 200 lines
pm2 restart meet-capture-api   # restart app
pm2 stop meet-capture-api      # stop app
```

## Health check

```bash
curl http://160.191.244.71:8787/health
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server health + captures root path |
| GET | `/dashboard` | Benchmark dashboard (live charts) |
| POST | `/api/capture/presign` | Generate presigned upload URLs |
| POST | `/api/capture/batch` | Upload batch of capture events |
| GET | `/api/sessions` | List all recorded sessions |
| GET | `/api/sessions/:sessionId` | Get session detail + manifest |
| GET | `/captures/*` | Serve static capture files |
| POST | `/api/checkin` | Manual check-in (teacher or student) |
| POST | `/api/auto-checkin` | Auto check-in by Google handle → email lookup → write attendance |
| POST | `/api/link-student` | Save Google handle → email mapping to DB |
| GET | `/api/student-by-handle/:handle` | Lookup email by Google handle |

## PM2 logs

```bash
# Live logs
ssh -i ~/.ssh/id_ed25519 root@160.191.244.71 "pm2 logs meet-capture-api"

# Last 100 lines (error only)
ssh -i ~/.ssh/id_ed25519 root@160.191.244.71 "pm2 logs meet-capture-api --lines 100 --nostream 2>&1 | grep error"
```

## Captures data

Saved to `/home/projects/meet-capture-api/captures/` on the server.

```bash
# Check disk usage
du -sh /home/projects/meet-capture-api/captures/

# List sessions
ls /home/projects/meet-capture-api/captures/
```
