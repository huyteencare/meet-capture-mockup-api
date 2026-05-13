#!/usr/bin/env node
// Usage: node scripts/benchmark-monitor.js [server-url]
// Default server URL: http://localhost:8787
// Polls /api/stats every 30s, prints live summary, writes CSV.

import { appendFile, writeFile } from "node:fs/promises";

const API_BASE = process.argv[2] || "http://localhost:8787";
const INTERVAL_MS = 30_000;

const startedAt = new Date();
const csvPath = `benchmark-${startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`;
const CSV_HEADER =
  "time,uptimeSeconds," +
  "cpuPercent,memRssMB," +
  "totalBatchRequests,batchesThisPeriod," +
  "totalEvents,eventsThisPeriod," +
  "totalMBReceived,mbThisPeriod," +
  "totalErrors,totalSavedFiles,diskUsageMB\n";

const mb = (bytes) => (bytes / 1048576).toFixed(2);
const pad = (label, value) => `${label.padEnd(20)} ${value}`;

let prev = null;
let initialized = false;

const poll = async () => {
  let data;
  try {
    const res = await fetch(`${API_BASE}/api/stats`, { signal: AbortSignal.timeout(5000) });
    data = await res.json();
  } catch (err) {
    console.error(`[monitor] Poll failed: ${err.message}`);
    return;
  }

  const now = new Date().toISOString();
  const batchesDelta = prev ? data.totalBatchRequests - prev.totalBatchRequests : "-";
  const eventsDelta  = prev ? data.totalEvents - prev.totalEvents : "-";
  const mbDelta      = prev ? mb(data.totalBytesReceived - prev.totalBytesReceived) : "-";

  // CSV row
  const row =
    `${now},${data.uptimeSeconds},` +
    `${(data.cpuPercent ?? "").toString()},${(data.memRssMB ?? "").toString()},` +
    `${data.totalBatchRequests},${batchesDelta},` +
    `${data.totalEvents},${eventsDelta},` +
    `${mb(data.totalBytesReceived)},${mbDelta},` +
    `${data.totalErrors},${data.totalSavedFiles},${mb(data.diskUsageBytes)}\n`;

  if (!initialized) {
    await writeFile(csvPath, CSV_HEADER);
    initialized = true;
  }
  await appendFile(csvPath, row);

  // Terminal display
  console.clear();
  console.log(`╔══ Benchmark Monitor ══════════════════════╗`);
  console.log(`║  Server : ${API_BASE}`);
  console.log(`║  Time   : ${now}`);
  console.log(`╠══ System ══════════════════════════════════╣`);
  console.log(`║  ${pad("CPU:", (data.cpuPercent ?? "—") + "%")}`);
  console.log(`║  ${pad("RAM (RSS):", (data.memRssMB ?? "—") + " MB")}`);
  console.log(`╠══ Totals ══════════════════════════════════╣`);
  console.log(`║  ${pad("Batches:", data.totalBatchRequests)}`);
  console.log(`║  ${pad("Events:", data.totalEvents)}`);
  console.log(`║  ${pad("Received:", mb(data.totalBytesReceived) + " MB")}`);
  console.log(`║  ${pad("Saved files:", data.totalSavedFiles)}`);
  console.log(`║  ${pad("Disk used:", mb(data.diskUsageBytes) + " MB")}`);
  console.log(`║  ${pad("Errors:", data.totalErrors)}`);
  console.log(`╠══ Last ${INTERVAL_MS / 1000}s ══════════════════════════════╣`);
  console.log(`║  ${pad("Batches:", batchesDelta)}`);
  console.log(`║  ${pad("Events:", eventsDelta)}`);
  console.log(`║  ${pad("MB received:", mbDelta)}`);
  console.log(`╠══ Output ══════════════════════════════════╣`);
  console.log(`║  CSV: ${csvPath}`);
  console.log(`╚════════════════════════════════════════════╝`);
  console.log(`  Uptime ${data.uptimeSeconds}s  |  Next poll in ${INTERVAL_MS / 1000}s  |  Ctrl+C to stop`);

  prev = data;
};

console.log(`Starting benchmark monitor → ${API_BASE}`);
console.log(`Output CSV: ${csvPath}\n`);

poll();
setInterval(poll, INTERVAL_MS);

process.on("SIGINT", () => {
  console.log(`\nStopped. CSV saved to: ${csvPath}`);
  process.exit(0);
});
