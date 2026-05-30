import { createApp, getDiskUsageBytes } from "./app.js";
import { createLmsClient } from "./supabase-db.js";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const capturesRoot = path.join(projectRoot, "captures");
const debugLogPath = path.join(capturesRoot, "_debug", "identity-flow.log.jsonl");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

const lmsSupabase = (() => {
  try { return createLmsClient(process.env); } catch { return null; }
})();

const { app, counters, activeSessions, ACTIVE_SESSION_TTL_MS, getCpuPercent } = createApp({
  capturesRoot,
  projectRoot,
  debugLogPath,
  webhookUrl: process.env.TEENCAREWORK_ATTENDANCE_DRAFT_URL?.trim() || "",
  webhookSecret: process.env.TEENCAREWORK_ATTENDANCE_DRAFT_SECRET?.trim() || "",
  lmsSupabase,
});

await mkdir(capturesRoot, { recursive: true });

const benchmarkCsvPath = path.join(
  projectRoot,
  `benchmark-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
);
const CSV_HEADER = "time,uptimeSeconds,cpuPercent,memRssMB,totalBatchRequests,totalEvents,totalMBReceived,totalErrors,totalSavedFiles,totalS3Uploads,totalS3Errors,totalS3BytesMB,activeSessionCount,diskUsageMB\n";
await writeFile(benchmarkCsvPath, CSV_HEADER);

const serverStartMs = Date.now();

setInterval(async () => {
  const diskUsageBytes = await getDiskUsageBytes(capturesRoot);
  const memRssMB = (process.memoryUsage().rss / 1048576).toFixed(1);
  const activeSessionCount = [...activeSessions.values()].filter(t => Date.now() - t < ACTIVE_SESSION_TTL_MS).length;
  const row =
    `${new Date().toISOString()},` +
    `${Math.floor((Date.now() - serverStartMs) / 1000)},` +
    `${getCpuPercent().toFixed(1)},` +
    `${memRssMB},` +
    `${counters.totalBatchRequests},` +
    `${counters.totalEvents},` +
    `${(counters.totalBytesReceived / 1048576).toFixed(2)},` +
    `${counters.totalErrors},` +
    `${counters.totalSavedFiles},` +
    `${counters.totalS3Uploads},` +
    `${counters.totalS3Errors},` +
    `${(counters.totalS3BytesUploaded / 1048576).toFixed(2)},` +
    `${activeSessionCount},` +
    `${(diskUsageBytes / 1048576).toFixed(2)}\n`;
  await appendFile(benchmarkCsvPath, row);
}, 30_000);

app.listen(port, host, () => {
  console.log(`Meet capture API listening on http://${host}:${port}`);
  console.log(`Captures root: ${capturesRoot}`);
  console.log(`Benchmark CSV: ${benchmarkCsvPath}`);
  console.log(`Identity debug log: ${debugLogPath}`);
});
