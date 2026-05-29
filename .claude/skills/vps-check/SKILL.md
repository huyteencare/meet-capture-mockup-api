---
name: vps-check
description: SSH into VPS to check meet-capture-api benchmark, sessions, errors, and system status. Use when asked to check server health, benchmark data, recording sessions, CPU/RAM/disk on the remote server.
---

meet-capture-api runs on VPS `160.191.244.71` managed by PM2. This skill SSHes in (readonly) and pulls benchmark CSV stats, session counts, and error logs.

**SSH key:** `~/.ssh/id_ed25519`  
**Deploy path:** `/home/projects/meet-capture-api/`  
**Benchmark CSV:** largest `benchmark-*.csv` in deploy path (the server writes one per process start; the current long-running one is ~1.5 MB+)

## Run (agent path)

```bash
bash .claude/skills/vps-check/check.sh [section]
```

Sections:
- `all` — everything (default)
- `benchmark` — CSV stats: current counters, daily file counts, peak CPU
- `sessions` — session counts per day, 10 newest, disk usage
- `errors` — last 30 lines of PM2 error log
- `system` — PM2 status, disk, `/health` endpoint

### Quick one-off SSH commands

```bash
SSH="ssh -i ~/.ssh/id_ed25519 root@160.191.244.71"
DEPLOY="/home/projects/meet-capture-api"
CSV=$($SSH "ls -t ${DEPLOY}/benchmark-*.csv | head -1")

# Latest stats row
$SSH "tail -1 $CSV"

# Sessions per day
$SSH "ls -lt ${DEPLOY}/captures/ | grep -v '^_\|^total\|_debug' | awk '{print \$NF, \$6, \$7, \$8}' | head -20"

# Peak CPU
$SSH "sort -t',' -k3 -rn $CSV | head -5 | cut -d',' -f1,3,4,13"

# PM2 error log
$SSH "tail -50 ~/.pm2/logs/meet-capture-api-error.log"
```

## Notes

- `totalErrors` = any 500 response (incl. ECONNABORTED when browser closes mid-upload — benign)
- `totalS3Errors` = GCS upload failures (these are real problems)
- CPU % is of **one Node.js thread** — VPS has 6 vCPU so Node can never exceed ~16% of total system CPU
- Benchmark CSV is cumulative counters since last `pm2 restart`
- Sessions folders under `captures/` are named with Google Meet meeting codes, not dates — use `ls -lt` to sort by mtime
