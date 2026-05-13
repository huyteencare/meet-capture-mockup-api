Full EC2 test workflow:

# 1. Start the monitor (writes CSV locally)
node scripts/benchmark-monitor.js http://18.142.106.202

# 2. Run your test (Google Meet + extension pointing to EC2)
#    Watch dashboard at http://18.142.106.202/dashboard in browser

# 3. After the test, Ctrl+C the monitor, then generate the report:
node scripts/benchmark-report.js benchmark-2026-05-13T...csv
Report output looks like:


╔══════════════════════════════════════════════════╗
║  Benchmark Report                                ║
╠══════════════════════════════════════════════════╣
║  ── Totals ─────────────────────────────────     ║
║  Test duration:       18.3 min  (1098s)          ║
║  Total batches:       412                        ║
║  Total events:        8240                       ║
║  Total received:      1240.5 MB                  ║
║  S3 uploads:          3280                       ║
╠══════════════════════════════════════════════════╣
║  ── Throughput ─────────────────────────────     ║
║  Batches / min:       22.5                       ║
║  Peak disk used:      12.40 MB                   ║
╚══════════════════════════════════════════════════╝
The key metric to watch is Peak disk — with S3 working it should stay very low (files upload and delete locally). If it climbs toward hundreds of MB, S3 isn't keeping up.