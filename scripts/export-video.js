#!/usr/bin/env node
// Usage:
//   node scripts/export-video.js <serverUrl> <sessionId>          ← list tracks (numbered)
//   node scripts/export-video.js <serverUrl> <sessionId> --track 3
//   node scripts/export-video.js <serverUrl> <sessionId> --track 3 --out out.webm

import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const API_BASE   = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const SESSION_ID = process.argv[3];

if (!SESSION_ID) {
  console.error("Usage: node scripts/export-video.js <serverUrl> <sessionId> [--role <role>] [--student <name>] [--out <file>]");
  process.exit(1);
}

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};
const TRACK_NUM = arg("--track") ? Number(arg("--track")) : null;
const OUT_FILE  = arg("--out");

// ── fetch session ─────────────────────────────────────────────────────────────

process.stdout.write(`Fetching session ${SESSION_ID}...\n`);
const res = await fetch(`${API_BASE}/api/sessions/${SESSION_ID}`, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) { console.error("Session not found"); process.exit(1); }
const { session } = await res.json();

const chunks = (session.events || []).filter((e) => e.type === "chunk");

// ── group by role / student ───────────────────────────────────────────────────

const tracks = new Map(); // key → { role, label, chunks[] }

// Detect UI affordance strings that Google Meet injects as fake participant names
const isRealName = (name, sid) =>
  name && name !== sid && !/^\d+$/.test(name) && !/you can'?t remotely\b/i.test(name);

for (const chunk of chunks) {
  const role  = chunk.metadata?.mediaRole || "unknown";
  const sid   = chunk.metadata?.streamId || chunk.metadata?.participantId || "unknown";
  const pid   = chunk.metadata?.participantId || sid;
  // Group student-video by streamId (stable) so recorder restarts + name changes don't split/merge tracks
  const key   = role === "student-video" ? `student-video::${sid}` : role;

  if (!tracks.has(key)) tracks.set(key, { role, label: sid, key, chunks: [] });

  // Upgrade label to the best resolved real name we've seen for this stream
  const t = tracks.get(key);
  if (isRealName(pid, sid) && !isRealName(t.label, sid)) t.label = pid;

  t.chunks.push(chunk);
}

// ── build numbered list ───────────────────────────────────────────────────────

const trackList = Array.from(tracks.values());

if (TRACK_NUM === null) {
  console.log(`\nSession: ${SESSION_ID}`);
  console.log(`Mentor:  ${session.mentorLabel || "—"}`);
  console.log(`Meeting: ${session.meetingId || "—"}\n`);
  console.log("Available tracks:\n");
  trackList.forEach((t, i) => {
    const mb  = (t.chunks.reduce((s, c) => s + (c.metadata?.byteSize || 0), 0) / 1048576).toFixed(1);
    const dur = Math.round(t.chunks.reduce((s, c) => s + (c.metadata?.durationMs || 0), 0) / 1000);
    const m   = Math.floor(dur / 60), sec = dur % 60;
    const num = String(i + 1).padStart(2);
    const label = t.role === "student-video" ? `student-video  ${t.label}` : t.role;
    console.log(`  [${num}]  ${label.padEnd(48)} ${t.chunks.length} chunks  ${m}:${String(sec).padStart(2,"0")}  ${mb} MB`);
  });
  console.log("\nRe-run with --track <number> to export.");
  process.exit(0);
}

// ── select track ──────────────────────────────────────────────────────────────

const selected = trackList[TRACK_NUM - 1];
if (!selected) {
  console.error(`Track ${TRACK_NUM} not found. Run without --track to see list.`);
  process.exit(1);
}

const sortedChunks = selected.chunks.sort((a, b) => (a.metadata?.index ?? 0) - (b.metadata?.index ?? 0));
console.log(`\nExporting: ${selected.role} — ${selected.label}`);
console.log(`Chunks: ${sortedChunks.length}`);

// ── download chunks ───────────────────────────────────────────────────────────

const tmpDir = join(tmpdir(), `meet-export-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

const concatList = [];
let downloaded = 0;

for (const chunk of sortedChunks) {
  const url = chunk.fileUrls?.recording;
  if (!url) { console.warn(`  skip chunk (no URL): index ${chunk.metadata?.index}`); continue; }

  const fileName = `chunk-${String(downloaded).padStart(5, "0")}.webm`;
  const filePath = join(tmpDir, fileName);

  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) { console.warn(`  skip chunk ${downloaded}: HTTP ${r.status}`); continue; }

  await pipeline(Readable.fromWeb(r.body), createWriteStream(filePath));
  concatList.push(`file '${filePath}'`);
  downloaded++;

  if (downloaded % 20 === 0) process.stdout.write(`  downloaded ${downloaded}/${sortedChunks.length} chunks...\r`);
}

console.log(`\nDownloaded ${downloaded} chunks.`);

if (downloaded === 0) { console.error("No chunks downloaded."); rmSync(tmpDir, { recursive: true }); process.exit(1); }

// ── group chunks by segment (each initChunk starts a new segment) ─────────────

const safeLabel = selected.label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
const outFile   = OUT_FILE || `${session.meetingId || "session"}-${safeLabel}.webm`;
const isAudio   = selected.role === "mentor-audio" || selected.role === "shared-audio";

const { createReadStream, createWriteStream: cws } = await import("node:fs");
const { statSync } = await import("node:fs");

// split into segments at each init chunk boundary
const segments = [];
for (const chunk of sortedChunks) {
  const path = concatList[sortedChunks.indexOf(chunk)]?.replace(/^file '/, "").replace(/'$/, "");
  if (!path) continue;
  if (chunk.metadata?.initChunk || segments.length === 0) segments.push([]);
  segments[segments.length - 1].push(path);
}

console.log(`Segments (recorder restarts + 1): ${segments.length}`);

// binary-concat each segment into its own valid WebM file
const segmentFiles = [];
for (let i = 0; i < segments.length; i++) {
  const segFile = join(tmpDir, `seg-${String(i).padStart(4, "0")}.webm`);
  const out = cws(segFile);
  for (const filePath of segments[i]) {
    await pipeline(createReadStream(filePath), out, { end: false });
  }
  out.end();
  await new Promise((r) => out.on("finish", r));
  segmentFiles.push(segFile);
}
console.log(`Binary-concat done. Re-encoding → ${outFile}  (may take a few minutes...)`);

// ffmpeg concat demuxer on complete segment files → re-encode
const listFile = join(tmpDir, "concat.txt");
writeFileSync(listFile, segmentFiles.map((f) => `file '${f}'`).join("\n"));

execFileSync("ffmpeg", [
  "-y",
  "-f", "concat", "-safe", "0",
  "-i", listFile,
  ...(isAudio
    ? ["-c:a", "libopus"]
    : ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "33", "-deadline", "realtime", "-c:a", "libopus"]),
  outFile,
], { stdio: "inherit" });

rmSync(tmpDir, { recursive: true });
const sizeMB = (statSync(outFile).size / 1048576).toFixed(1);
console.log(`\nDone: ${outFile}  (${sizeMB} MB)`);
