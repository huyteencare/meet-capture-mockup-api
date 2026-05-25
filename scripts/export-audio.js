#!/usr/bin/env node
// Export audio từ 1 meeting session ra file .mp3
//
// Usage:
//   node scripts/export-audio.js <meetingId>                              ← list sessions + tracks
//   node scripts/export-audio.js <meetingId> --track 2                    ← export full track
//   node scripts/export-audio.js <meetingId> --track 2 --clip 1:30-1:45  ← cắt đoạn 15s
//   node scripts/export-audio.js <meetingId> --track 2 --split            ← tự chia 13s clips
//   node scripts/export-audio.js <meetingId> --track 2 --clip 1:30-1:45 --transcribe  ← + speech-to-text
//   node scripts/export-audio.js <meetingId> --track 2 --split --transcribe            ← transcribe mỗi clip
//
// Requires OPENAI_API_KEY env var khi dùng --transcribe
//
// Ví dụ:
//   node scripts/export-audio.js awb-eqbz-odz
//   node scripts/export-audio.js awb-eqbz-odz --track 4 --split --transcribe

import { execFileSync } from "node:child_process";
import { createWriteStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const SERVER = process.env.MEET_SERVER || "http://160.191.244.71:8787";
const MEETING_ID = process.argv[2];

if (!MEETING_ID || MEETING_ID.startsWith("--")) {
  console.error("Usage: node scripts/export-audio.js <meetingId> [--session N] [--track N] [--out file.mp3]");
  console.error("       node scripts/export-audio.js awb-eqbz-odz");
  process.exit(1);
}

const arg = (flag) => { const i = process.argv.indexOf(flag); return i !== -1 ? process.argv[i + 1] : null; };
const TRACK_NUM   = arg("--track")   ? Number(arg("--track"))   : null;
const SESSION_NUM = arg("--session") ? Number(arg("--session")) : null;
const OUT_FILE    = arg("--out");
const CLIP        = arg("--clip");   // format: "1:30-1:45" or "90-105" (seconds)
const SPLIT       = process.argv.includes("--split") ? Number(arg("--split") ?? "13") : null;
const TRANSCRIBE  = process.argv.includes("--transcribe");

const transcribe = async (filePath) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error("OPENAI_API_KEY not set — skipping transcription"); return null; }
  const { readFileSync } = await import("node:fs");
  const form = new FormData();
  form.append("file", new Blob([readFileSync(filePath)], { type: "audio/mpeg" }), filePath.split("/").pop());
  form.append("model", "whisper-1");
  form.append("language", "vi");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) { console.error("Whisper API error:", await res.text()); return null; }
  const { text } = await res.json();
  return text?.trim() || null;
};

const parseClip = (clip) => {
  if (!clip) return null;
  const toSec = (s) => {
    const parts = s.trim().split(":").map(Number);
    return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0];
  };
  const [start, end] = clip.split("-");
  return { start: toSec(start), end: toSec(end) };
};

// ── fetch all sessions for this meeting ───────────────────────────────────────

process.stdout.write(`Fetching sessions for meeting ${MEETING_ID}...\n`);
const listRes = await fetch(`${SERVER}/api/sessions`, { signal: AbortSignal.timeout(30_000) });
if (!listRes.ok) { console.error("Cannot reach server:", SERVER); process.exit(1); }
const { sessions } = await listRes.json();

const matching = sessions
  .filter((s) => s.meetingId === MEETING_ID)
  .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));

if (matching.length === 0) {
  console.error(`No sessions found for meeting "${MEETING_ID}".`);
  console.error("Check the meeting ID — it should look like: awb-eqbz-odz");
  process.exit(1);
}

// ── pick session ──────────────────────────────────────────────────────────────

let session;
if (matching.length === 1) {
  session = matching[0];
} else if (SESSION_NUM !== null) {
  session = matching[SESSION_NUM - 1];
  if (!session) { console.error(`Session ${SESSION_NUM} not found. There are ${matching.length} sessions.`); process.exit(1); }
} else {
  console.log(`\nFound ${matching.length} sessions for ${MEETING_ID}:\n`);
  matching.forEach((s, i) => {
    const start = new Date(s.startedAt).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const updated = new Date(s.updatedAt).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    console.log(`  [${i + 1}]  ${start} → ${updated}  mentor: ${s.mentorLabel || "(unknown)"}  (${s.sessionId.slice(0, 40)}...)`);
  });
  console.log("\nRe-run with --session <number> to pick one.");
  process.exit(0);
}

// ── fetch full session detail ─────────────────────────────────────────────────

const detailRes = await fetch(`${SERVER}/api/sessions/${session.sessionId}`, { signal: AbortSignal.timeout(30_000) });
if (!detailRes.ok) { console.error("Cannot fetch session detail"); process.exit(1); }
const { session: detail } = await detailRes.json();

const chunks = (detail.events || []).filter((e) => e.type === "chunk");

// ── group into audio tracks only ──────────────────────────────────────────────

const tracks = new Map();
for (const chunk of chunks) {
  const role = chunk.metadata?.mediaRole || "unknown";
  if (!["mentor-audio", "shared-audio"].includes(role)) continue;

  const sid = chunk.metadata?.streamId || chunk.metadata?.participantId || "unknown";
  const key = role === "shared-audio" ? `shared-audio::${sid}` : role;

  if (!tracks.has(key)) tracks.set(key, { role, label: role === "shared-audio" ? `shared-audio (${sid})` : "mentor-audio", key, chunks: [] });
  tracks.get(key).chunks.push(chunk);
}

const trackList = Array.from(tracks.values());

// ── list mode ─────────────────────────────────────────────────────────────────

if (TRACK_NUM === null) {
  const start = new Date(detail.startedAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
  console.log(`\nMeeting:  ${MEETING_ID}`);
  console.log(`Mentor:   ${detail.mentorLabel || "—"}`);
  console.log(`Started:  ${start} (VN time)`);
  console.log(`Session:  ${detail.sessionId}\n`);
  console.log("Audio tracks:\n");

  if (trackList.length === 0) {
    console.log("  (no audio tracks found in this session)");
    process.exit(0);
  }

  trackList.forEach((t, i) => {
    const mb  = (t.chunks.reduce((s, c) => s + (c.metadata?.byteSize || 0), 0) / 1048576).toFixed(1);
    const dur = Math.round(t.chunks.reduce((s, c) => s + (c.metadata?.durationMs || 0), 0) / 1000);
    const m   = Math.floor(dur / 60), sec = dur % 60;
    console.log(`  [${i + 1}]  ${t.label.padEnd(36)} ${t.chunks.length} chunks  ${m}:${String(sec).padStart(2, "0")}  ~${mb} MB`);
  });

  console.log("\nRe-run with --track <number> to export as .mp3.");
  process.exit(0);
}

// ── export ────────────────────────────────────────────────────────────────────

const selected = trackList[TRACK_NUM - 1];
if (!selected) {
  console.error(`Track ${TRACK_NUM} not found. Run without --track to see list.`);
  process.exit(1);
}

const sortedChunks = selected.chunks.sort((a, b) => (a.metadata?.index ?? 0) - (b.metadata?.index ?? 0));
const totalMB = (sortedChunks.reduce((s, c) => s + (c.metadata?.byteSize || 0), 0) / 1048576).toFixed(1);
console.log(`\nExporting: ${selected.label}  (${sortedChunks.length} chunks, ~${totalMB} MB download)`);

const tmpDir = join(tmpdir(), `meet-audio-export-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });

// download chunks
const concatList = [];
let downloaded = 0;
for (const chunk of sortedChunks) {
  const url = chunk.fileUrls?.recording;
  if (!url) { console.warn(`  skip chunk (no URL): index ${chunk.metadata?.index}`); continue; }

  const filePath = join(tmpDir, `chunk-${String(downloaded).padStart(5, "0")}.webm`);
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) { console.warn(`  skip chunk ${downloaded}: HTTP ${r.status}`); continue; }

  await pipeline(Readable.fromWeb(r.body), createWriteStream(filePath));
  concatList.push(filePath);
  downloaded++;

  process.stdout.write(`  ${downloaded}/${sortedChunks.length} chunks\r`);
}
console.log(`\nDownloaded ${downloaded} chunks.`);
if (downloaded === 0) { console.error("No chunks downloaded."); rmSync(tmpDir, { recursive: true }); process.exit(1); }

// split into segments at each initChunk boundary then binary-concat each segment
const segments = [];
for (let i = 0; i < sortedChunks.length; i++) {
  const chunk = sortedChunks[i];
  const path  = concatList[i];
  if (!path) continue;
  if (chunk.metadata?.initChunk || segments.length === 0) segments.push([]);
  segments[segments.length - 1].push(path);
}

const segmentFiles = [];
for (let i = 0; i < segments.length; i++) {
  const segFile = join(tmpDir, `seg-${String(i).padStart(4, "0")}.webm`);
  const out = createWriteStream(segFile);
  const { createReadStream } = await import("node:fs");
  for (const filePath of segments[i]) {
    await pipeline(createReadStream(filePath), out, { end: false });
  }
  out.end();
  await new Promise((r) => out.on("finish", r));
  segmentFiles.push(segFile);
}

// build output filename
const safeDate   = new Date(detail.startedAt).toISOString().slice(0, 10);
const safeMentor = (detail.mentorLabel || "mentor").replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
const safeTrack  = selected.label.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
const clipRange  = parseClip(CLIP);
const clipSuffix = clipRange ? `_clip-${CLIP.replace(/[^0-9:-]/g, "")}` : "";
const defaultOut = `${MEETING_ID}_${safeDate}_${safeMentor}_${safeTrack}${clipSuffix}.mp3`;
const outFile    = OUT_FILE || defaultOut;
const isMP3      = extname(outFile).toLowerCase() !== ".webm";

const listFile = join(tmpDir, "concat.txt");
writeFileSync(listFile, segmentFiles.map((f) => `file '${f}'`).join("\n"));

if (clipRange) {
  const dur = clipRange.end - clipRange.start;
  console.log(`Clip: ${CLIP}  (${dur}s)  → ${outFile}`);
  execFileSync("ffmpeg", [
    "-y",
    "-f", "concat", "-safe", "0",
    "-i", listFile,
    "-ss", String(clipRange.start),
    "-t",  String(dur),
    ...(isMP3 ? ["-vn", "-c:a", "libmp3lame", "-q:a", "4"] : ["-c:a", "libopus"]),
    outFile,
  ], { stdio: "inherit" });
} else {
  console.log(`Re-encoding → ${outFile}  (may take a minute...)`);
  execFileSync("ffmpeg", [
    "-y",
    "-f", "concat", "-safe", "0",
    "-i", listFile,
    ...(isMP3 ? ["-vn", "-c:a", "libmp3lame", "-q:a", "4"] : ["-c:a", "libopus"]),
    outFile,
  ], { stdio: "inherit" });
}

rmSync(tmpDir, { recursive: true });

if (SPLIT) {
  const clipDir = outFile.replace(/\.mp3$/, "") + "_clips";
  mkdirSync(clipDir, { recursive: true });
  execFileSync("ffmpeg", [
    "-y", "-i", outFile,
    "-f", "segment", "-segment_time", String(SPLIT),
    "-c", "copy",
    join(clipDir, "clip-%03d.mp3"),
  ], { stdio: "inherit" });

  const { readdirSync } = await import("node:fs");
  const clips = readdirSync(clipDir).filter((f) => f.endsWith(".mp3")).sort();
  console.log(`\nSplit into ${clips.length} clips of ~${SPLIT}s → ${clipDir}/\n`);

  for (let i = 0; i < clips.length; i++) {
    const f = clips[i];
    const sec = i * SPLIT;
    const m = Math.floor(sec / 60), s = sec % 60;
    const sizekb = Math.round(statSync(join(clipDir, f)).size / 1024);
    const timestamp = `${m}:${String(s).padStart(2, "0")}`;

    if (TRANSCRIBE) {
      process.stdout.write(`  ${f}  (${timestamp})  transcribing...`);
      const text = await transcribe(join(clipDir, f));
      const txtFile = join(clipDir, f.replace(/\.mp3$/, ".txt"));
      if (text) {
        (await import("node:fs")).writeFileSync(txtFile, text, "utf8");
        process.stdout.write(`\r  ${f}  (${timestamp})  ${sizekb} kB\n    → ${text}\n`);
      } else {
        process.stdout.write(`\r  ${f}  (${timestamp})  ${sizekb} kB  (no transcript)\n`);
      }
    } else {
      console.log(`  ${f}  (${timestamp})  ${sizekb} kB`);
    }
  }
  if (!TRANSCRIBE) console.log(`\nAdd --transcribe to generate text for each clip.`);
} else {
  const sizeMB = (statSync(outFile).size / 1048576).toFixed(1);
  console.log(`\nDone: ${outFile}  (${sizeMB} MB)`);

  if (TRANSCRIBE) {
    console.log("Transcribing...");
    const text = await transcribe(outFile);
    if (text) {
      const txtFile = outFile.replace(/\.mp3$/, ".txt");
      (await import("node:fs")).writeFileSync(txtFile, text, "utf8");
      console.log(`Transcript → ${txtFile}\n${text}`);
    }
  }
}
