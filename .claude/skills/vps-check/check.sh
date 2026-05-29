#!/usr/bin/env bash
# Usage: bash .claude/skills/vps-check/check.sh [section]
# Sections: all (default), benchmark, sessions, errors, system
set -euo pipefail

SSH="ssh -i ~/.ssh/id_ed25519 root@160.191.244.71"
DEPLOY="/home/projects/meet-capture-api"
SECTION="${1:-all}"

latest_csv() {
  $SSH "ls -t ${DEPLOY}/benchmark-*.csv 2>/dev/null | head -1"
}

do_benchmark() {
  local csv
  csv=$(latest_csv)
  if [[ -z "$csv" ]]; then
    echo "No benchmark CSV found on VPS."
    return
  fi

  echo "=== Benchmark file: $(basename "$csv") ==="
  echo ""

  echo "--- Current stats (latest row) ---"
  $SSH "tail -1 $csv" | awk -F',' '{
    printf "Uptime:      %d h %d m\n", int($2/3600), int(($2%3600)/60)
    printf "CPU:         %s%%\n", $3
    printf "RAM:         %s MB\n", $4
    printf "Batches:     %s\n", $5
    printf "Events:      %s\n", $6
    printf "Received:    %s MB\n", $7
    printf "Errors:      %s\n", $8
    printf "Saved files: %s\n", $9
    printf "GCS uploads: %s\n", $10
    printf "GCS errors:  %s\n", $11
    printf "GCS MB:      %s MB\n", $12
    printf "Active sess: %s\n", $13
    printf "Disk used:   %s MB\n", $14
  }'

  echo ""
  echo "--- Sessions per day (from benchmark) ---"
  $SSH "awk -F',' 'NR>1 {day=substr(\$1,1,10); files[day]=\$9} END {for(d in files) print d, files[d]}' $csv | sort"

  echo ""
  echo "--- Peak CPU (top 5) ---"
  $SSH "sort -t',' -k3 -rn $csv | head -5 | cut -d',' -f1,3,4,13 | column -t -s','"
}

do_sessions() {
  echo "=== Sessions on VPS ==="
  echo ""

  echo "--- Total session count ---"
  $SSH "ls ${DEPLOY}/captures/ | grep -v '^_' | wc -l"

  echo ""
  echo "--- Sessions per day (by folder mtime) ---"
  $SSH "for d in 21 22 23 24 25 26 27; do
    count=\$(ls -la ${DEPLOY}/captures/ | grep \"May \$d \" | grep -v '_debug\|^total' | wc -l)
    echo \"May \$d: \$count sessions\"
  done"

  echo ""
  echo "--- 10 newest sessions ---"
  $SSH "ls -lt ${DEPLOY}/captures/ | grep -v '^_\|^total\|_debug' | head -10 | awk '{print \$NF, \$6, \$7, \$8}'"

  echo ""
  echo "--- Disk usage ---"
  $SSH "du -sh ${DEPLOY}/captures/"
}

do_errors() {
  echo "=== Errors ==="
  echo ""

  echo "--- PM2 error log (last 30 lines) ---"
  $SSH "tail -30 ~/.pm2/logs/meet-capture-api-error.log 2>/dev/null || echo '(no error log)'"
}

do_system() {
  echo "=== System ==="
  echo ""

  echo "--- PM2 status ---"
  $SSH "pm2 status meet-capture-api --no-color"

  echo ""
  echo "--- Disk ---"
  $SSH "df -h / | tail -1"

  echo ""
  echo "--- Server health ---"
  curl -sf http://160.191.244.71:8787/health | python3 -m json.tool 2>/dev/null || \
    curl -s http://160.191.244.71:8787/health
}

case "$SECTION" in
  benchmark) do_benchmark ;;
  sessions)  do_sessions ;;
  errors)    do_errors ;;
  system)    do_system ;;
  all)
    do_system
    echo ""
    do_benchmark
    echo ""
    do_sessions
    echo ""
    do_errors
    ;;
  *)
    echo "Unknown section: $SECTION"
    echo "Usage: $0 [all|benchmark|sessions|errors|system]"
    exit 1
    ;;
esac
