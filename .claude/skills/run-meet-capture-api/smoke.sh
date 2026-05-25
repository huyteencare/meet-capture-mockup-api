#!/usr/bin/env bash
# Smoke-test driver for meet-capture-api.
# Starts the server on a free port, exercises every route, then stops cleanly.
# Usage: bash .claude/skills/run-meet-capture-api/smoke.sh
# Requires: node >=20, no cloud credentials needed.

set -euo pipefail

PORT=18787
BASE="http://127.0.0.1:$PORT"
FAIL=0

cleanup() {
  [[ -n "${SERVER_PID:-}" ]] && kill "$SERVER_PID" 2>/dev/null || true
  # remove smoke session
  rm -rf captures/smoke-driver-mtg
  # remove benchmark csv written by server
  rm -f benchmark-*.csv
}
trap cleanup EXIT

check() {
  local label="$1" url="$2" method="${3:-GET}" body="${4:-}"
  local out
  if [[ "$method" == "POST" && -n "$body" ]]; then
    out=$(curl -s -X POST "$url" -H "Content-Type: application/json" -d "$body")
  else
    out=$(curl -s "$url")
  fi
  local ok
  ok=$(echo "$out" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('ok','?'))" 2>/dev/null || echo "parse-error")
  if [[ "$ok" == "True" || "$ok" == "true" ]]; then
    echo "PASS  $label"
  else
    echo "FAIL  $label  →  $out"
    FAIL=1
  fi
}

# ── launch ─────────────────────────────────────────────────────────────────────
PORT=$PORT HOST=127.0.0.1 STORAGE_PROVIDER=gcs node src/server.js &
SERVER_PID=$!
for i in {1..20}; do
  curl -s "$BASE/health" >/dev/null 2>&1 && break
  sleep 0.2
done

# ── route checks ───────────────────────────────────────────────────────────────
check "GET /health"  "$BASE/health"

check "POST /api/capture/batch" "$BASE/api/capture/batch" POST \
  '{"meetingId":"smoke-driver-mtg","sessionId":"smoke-driver-sess","captureRole":"mentor","events":[{"type":"hook-installed","at":1000000,"metadata":{"timestamp":1000000}}]}'

check "GET /api/sessions"       "$BASE/api/sessions"

check "GET /api/sessions/:id"   "$BASE/api/sessions/smoke-driver-sess"

# presign returns 503 without storage creds — that's expected and correct
presign_out=$(curl -s -X POST "$BASE/api/capture/presign" \
  -H "Content-Type: application/json" \
  -d '{"meetingId":"smoke-driver-mtg","sessionId":"smoke-driver-sess","files":[{"name":"test.webm","contentType":"video/webm"}]}')
presign_reason=$(echo "$presign_out" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason','?'))" 2>/dev/null)
if [[ "$presign_reason" == "Storage not configured" ]]; then
  echo "PASS  POST /api/capture/presign (503 Storage not configured — expected)"
else
  echo "FAIL  POST /api/capture/presign unexpected response: $presign_out"
  FAIL=1
fi

# ── result ─────────────────────────────────────────────────────────────────────
echo ""
if [[ $FAIL -eq 0 ]]; then
  echo "All checks passed."
  exit 0
else
  echo "Some checks FAILED."
  exit 1
fi
