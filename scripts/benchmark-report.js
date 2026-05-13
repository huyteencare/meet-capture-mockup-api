#!/usr/bin/env node
// Usage: node scripts/benchmark-report.js <csv-file>
// Reads a CSV produced by benchmark-monitor.js and prints a summary report.

import { readFile } from "node:fs/promises";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: node scripts/benchmark-report.js <csv-file>");
  process.exit(1);
}

const text = await readFile(csvPath, "utf8");
const lines = text.trim().split("\n").filter((l) => !l.startsWith("#") && l.trim());

if (lines.length < 2) {
  console.error("Not enough data in CSV (need at least header + 1 row).");
  process.exit(1);
}

const headers = lines[0].split(",").map((h) => h.trim());
const rows = lines.slice(1).map((line) => {
  const values = line.split(",");
  return Object.fromEntries(headers.map((h, i) => [h, values[i]?.trim() ?? ""]));
});

const first = rows[0];
const last = rows[rows.length - 1];

const num = (key) => Number(last[key] || 0);
const totalBatches   = num("totalBatchRequests");
const totalEvents    = num("totalEvents");
const totalMB        = Number(last.totalMBReceived   || last.totalMBReceived   || 0);
const totalErrors    = num("totalErrors");
const totalSaved     = num("totalSavedFiles");
const totalS3        = num("totalS3Uploads");
const totalS3Errors  = num("totalS3Errors");

const peakDiskMB     = Math.max(...rows.map((r) => Number(r.diskUsageMB) || 0));

const hasCpu = headers.includes("cpuPercent");
const peakCpu  = hasCpu ? Math.max(...rows.map((r) => Number(r.cpuPercent) || 0)).toFixed(1) : null;
const avgCpu   = hasCpu ? (rows.reduce((s, r) => s + (Number(r.cpuPercent) || 0), 0) / rows.length).toFixed(1) : null;
const peakRam  = hasCpu ? Math.max(...rows.map((r) => Number(r.memRssMB) || 0)).toFixed(1) : null;
const avgRam   = hasCpu ? (rows.reduce((s, r) => s + (Number(r.memRssMB) || 0), 0) / rows.length).toFixed(1) : null;

const startUptime    = Number(first.uptimeSeconds || 0);
const endUptime      = Number(last.uptimeSeconds  || 0);
const durationS      = endUptime - startUptime;
const durationMin    = (durationS / 60).toFixed(1);

const batchesPerMin  = durationS > 0 ? (totalBatches / durationS * 60).toFixed(1) : "—";
const eventsPerMin   = durationS > 0 ? (totalEvents  / durationS * 60).toFixed(0) : "—";
const mbPerMin       = durationS > 0 ? (totalMB      / durationS * 60).toFixed(2) : "—";

// Per-period throughput peaks (from batchesThisPeriod / mbThisPeriod columns if present)
const hasPeriod = headers.includes("batchesThisPeriod");
let peakBatchesPeriod = "—";
let peakMbPeriod      = "—";
if (hasPeriod) {
  peakBatchesPeriod = String(Math.max(...rows.map((r) => Number(r.batchesThisPeriod) || 0)));
  peakMbPeriod      = Math.max(...rows.map((r) => Number(r.mbThisPeriod) || 0)).toFixed(2);
}

const W = 50;
const line = (label, value) => {
  const row = `  ${label.padEnd(22)} ${value}`;
  return `║${row.padEnd(W)}║`;
};
const divider = `╠${"═".repeat(W)}╣`;
const cap = (title) => {
  const t = `  ${title}`;
  return `║${t.padEnd(W)}║`;
};

console.log(`\n╔${"═".repeat(W)}╗`);
console.log(`║  Benchmark Report${" ".repeat(W - 18)}║`);
console.log(`║  ${csvPath.slice(-W + 4).padEnd(W - 2)}║`);
console.log(divider);
console.log(cap("── Totals ──────────────────────────────────"));
console.log(line("Test duration:", `${durationMin} min  (${durationS}s)`));
console.log(line("Total batches:", totalBatches));
console.log(line("Total events:", totalEvents));
console.log(line("Total received:", `${totalMB} MB`));
console.log(line("Total files saved:", totalSaved));
if (totalS3 > 0 || totalS3Errors > 0) {
  const s3Label = totalS3Errors > 0 ? `${totalS3}  (${totalS3Errors} errors)` : String(totalS3);
  console.log(line("S3 uploads:", s3Label));
}
console.log(line("Total errors:", totalErrors));
console.log(divider);
console.log(cap("── Throughput (avg / interval) ─────────────"));
console.log(line("Batches / min:", batchesPerMin));
console.log(line("Events / min:", eventsPerMin));
console.log(line("MB / min:", mbPerMin));
if (hasPeriod) {
  console.log(line("Peak batches / interval:", peakBatchesPeriod));
  console.log(line("Peak MB / interval:", peakMbPeriod));
}
if (hasCpu) {
  console.log(divider);
  console.log(cap("── System ───────────────────────────────────"));
  console.log(line("CPU avg / peak:", `${avgCpu}% / ${peakCpu}%`));
  console.log(line("RAM avg / peak:", `${avgRam} MB / ${peakRam} MB`));
}
console.log(divider);
console.log(cap("── Disk ─────────────────────────────────────"));
console.log(line("Peak disk used:", `${peakDiskMB.toFixed(2)} MB`));
console.log(line("Final disk:", `${Number(last.diskUsageMB || 0).toFixed(2)} MB`));
console.log(line("Samples:", rows.length));
console.log(`╚${"═".repeat(W)}╝\n`);
