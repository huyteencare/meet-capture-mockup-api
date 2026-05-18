import cors from "cors";
import {
  generateDownloadUrl,
  generateUploadUrl,
  isConfigured as isStorageConfigured,
  uploadFileAndDelete,
} from "./storage.js";
import express from "express";
import morgan from "morgan";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const capturesRoot = path.join(projectRoot, "captures");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

const serverStartMs = Date.now();
const counters = {
  totalBatchRequests: 0,
  totalEvents: 0,
  totalBytesReceived: 0,
  totalSavedFiles: 0,
  totalErrors: 0,
  totalS3Uploads: 0,
  totalS3Errors: 0,
  totalS3BytesUploaded: 0,
};

const activeSessions = new Set();

const signEventFiles = async (events, capturePath) => {
  if (!isStorageConfigured()) return events;
  return Promise.all(
    events.map(async (event) => {
      const files = event.files || {};
      if (Object.keys(files).length === 0) return event;
      const fileUrls = {};
      await Promise.all(
        Object.entries(files).map(async ([key, relPath]) => {
          // Direct-upload chunks store the full storage key; legacy chunks store relative local paths
          const storageKey = String(relPath).startsWith("captures/")
            ? relPath
            : `captures/${capturePath}/${relPath}`;
          try {
            fileUrls[key] = await generateDownloadUrl(storageKey, 3600);
          } catch {
            // file not in storage (local-only session) — viewer falls back to static path
          }
        }),
      );
      return { ...event, fileUrls };
    }),
  );
};

let lastCpuUsage = process.cpuUsage();
let lastCpuMs = Date.now();
let cpuPercent = 0;

setInterval(() => {
  const now = Date.now();
  const delta = process.cpuUsage(lastCpuUsage);
  const elapsedUs = (now - lastCpuMs) * 1000;
  cpuPercent = Math.min(100, ((delta.user + delta.system) / elapsedUs) * 100);
  lastCpuUsage = process.cpuUsage();
  lastCpuMs = now;
}, 5000).unref();

const app = express();

app.use(morgan("combined"));
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "250mb" }));
app.use("/captures", express.static(capturesRoot));

const sanitizeSegment = (value, fallback) => {
  const sanitized = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  return sanitized || fallback;
};

const parseDataUrl = (dataUrl) => {
  const value = String(dataUrl || "");

  if (!value.startsWith("data:")) {
    throw new Error("Invalid data URL");
  }

  const commaIndex = value.indexOf(",");

  if (commaIndex < 0) {
    throw new Error("Invalid data URL");
  }

  const metadata = value.slice(5, commaIndex);
  const data = value.slice(commaIndex + 1);
  const metadataParts = metadata.split(";").filter(Boolean);
  const mimeType = metadataParts[0] || "application/octet-stream";
  const isBase64 = metadataParts.includes("base64");
  const buffer = isBase64
    ? Buffer.from(data, "base64")
    : Buffer.from(decodeURIComponent(data), "utf8");

  return { buffer, mimeType };
};

const decodeNumberArray = (values, bytesPerValue) => {
  if (!Array.isArray(values)) {
    return Buffer.alloc(0);
  }

  if (bytesPerValue === 4) {
    const buffer = Buffer.alloc(values.length * 4);

    values.forEach((value, index) => {
      buffer.writeFloatLE(Number(value) || 0, index * 4);
    });

    return buffer;
  }

  return Buffer.from(values.map((value) => Number(value) || 0));
};

const readManifest = async (manifestPath) => {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
};

const writeJson = async (filePath, value) => {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const buildCapturePath = (meetingId, sessionId) => path.join(meetingId, sessionId);

const buildCaptureBaseUrl = (capturePath) =>
  `/captures/${capturePath.split(path.sep).map(encodeURIComponent).join("/")}`;

const getEventMeta = (event) => event?.metadata || event?.payload || {};

const formatDurationMs = (durationMs) => {
  const totalMs = Math.max(0, Number(durationMs || 0));
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const buildNameByStreamId = (manifest) => {
  const nameByStreamId = {};

  for (const participant of manifest.participantsSeen || []) {
    if (participant?.participantKey && participant?.participantName) {
      nameByStreamId[String(participant.participantKey)] = String(participant.participantName);
    }
  }

  for (const event of manifest.events || []) {
    if (event.type !== "participant-renamed") continue;
    const meta = getEventMeta(event);
    if (meta?.streamId && meta?.name) {
      nameByStreamId[String(meta.streamId)] = String(meta.name);
    }
  }

  return nameByStreamId;
};

const resolveStudentName = (streamId, meta, nameByStreamId) => {
  const streamKey = String(streamId || "").trim();
  if (streamKey && nameByStreamId[streamKey]) return nameByStreamId[streamKey];

  const participantId = String(meta?.participantId || "").trim();
  if (
    participantId &&
    participantId !== streamKey &&
    !participantId.startsWith("__")
  ) {
    return participantId;
  }

  return streamKey || "unknown";
};

const buildCaptureSummary = (manifest) => {
  const nameByStreamId = buildNameByStreamId(manifest);
  const students = new Map();

  for (const event of manifest.events || []) {
    const meta = getEventMeta(event);
    const streamId = meta?.streamId;
    if (!streamId || meta?.mediaRole !== "student-video") continue;

    const ownerId = String(meta?.ownerId || "").trim();
    const participantName = resolveStudentName(streamId, meta, nameByStreamId);
    const groupKey = ownerId || participantName;
    if (!groupKey || groupKey === "unknown") continue;

    if (!students.has(groupKey)) {
      students.set(groupKey, {
        ownerId: ownerId || null,
        participantName,
        streamIds: new Set(),
        joinObservedAt: Number(event.at || 0) || null,
        leaveObservedAt: Number(event.at || 0) || null,
        firstChunkAt: null,
        lastChunkAt: null,
        actualVideoDurationMs: 0,
        videoChunkCount: 0,
      });
    }

    const summary = students.get(groupKey);
    if (!summary.ownerId && ownerId) summary.ownerId = ownerId;
    if (summary.participantName === groupKey && participantName !== groupKey) {
      summary.participantName = participantName;
    }
    const eventAt = Number(event.at || 0) || null;

    summary.streamIds.add(String(streamId));
    if (eventAt) {
      summary.joinObservedAt = summary.joinObservedAt
        ? Math.min(summary.joinObservedAt, eventAt)
        : eventAt;
      summary.leaveObservedAt = summary.leaveObservedAt
        ? Math.max(summary.leaveObservedAt, eventAt)
        : eventAt;
    }

    if (event.type === "chunk") {
      summary.videoChunkCount += 1;
      summary.actualVideoDurationMs += Math.max(0, Number(meta.durationMs || 0));
      if (eventAt) {
        summary.firstChunkAt = summary.firstChunkAt
          ? Math.min(summary.firstChunkAt, eventAt)
          : eventAt;
        summary.lastChunkAt = summary.lastChunkAt
          ? Math.max(summary.lastChunkAt, eventAt)
          : eventAt;
      }
    }
  }

  const participants = Array.from(students.values())
    .filter((student) => {
      if (student.videoChunkCount > 0) return true;
      // suppress ownerless raw-UUID entries with no chunks
      return !/^[a-f0-9-]{8,}$/.test(student.participantName);
    })
    .map((student) => ({
      ownerId: student.ownerId || null,
      participantName: student.participantName,
      streamIds: Array.from(student.streamIds),
      joinObservedAt: student.joinObservedAt,
      leaveObservedAt: student.leaveObservedAt,
      firstChunkAt: student.firstChunkAt,
      lastChunkAt: student.lastChunkAt,
      actualVideoDurationMs: student.actualVideoDurationMs,
      actualVideoDurationLabel: formatDurationMs(student.actualVideoDurationMs),
      videoChunkCount: student.videoChunkCount,
    }))
    .sort((left, right) => Number(left.joinObservedAt || 0) - Number(right.joinObservedAt || 0));

  return {
    studentVideoParticipants: participants,
    totals: {
      studentCount: participants.length,
      totalVideoChunkCount: participants.reduce((sum, participant) => sum + participant.videoChunkCount, 0),
      totalActualVideoDurationMs: participants.reduce((sum, participant) => sum + participant.actualVideoDurationMs, 0),
      totalActualVideoDurationLabel: formatDurationMs(
        participants.reduce((sum, participant) => sum + participant.actualVideoDurationMs, 0),
      ),
    },
  };
};

const getChunkStorageInfo = (payload, fallbackBaseName) => {
  const mediaRole = String(payload.mediaRole || "").trim();
  const streamId = sanitizeSegment(payload.streamId, "stream");
  const participantId = sanitizeSegment(payload.participantId, streamId);
  const safeIndex = String(Number(payload.index ?? 0)).padStart(6, "0");
  const baseName = `chunk-${safeIndex}-${fallbackBaseName}`;

  if (mediaRole === "mentor-audio") {
    return {
      dirParts: ["mentor-audio"],
      fileName: `${baseName}.webm`,
    };
  }

  if (mediaRole === "shared-audio") {
    return {
      dirParts: ["shared-audio"],
      fileName: `${baseName}.webm`,
    };
  }

  if (mediaRole === "student-video") {
    return {
      dirParts: ["participants", participantId, "video"],
      fileName: `${baseName}.webm`,
    };
  }

  return {
    dirParts: ["recordings"],
    fileName: `${fallbackBaseName}.bin`,
  };
};

const buildChunkStorageKey = (meetingId, sessionId, payload, baseName) => {
  const storage = getChunkStorageInfo(payload, baseName);
  return [
    "captures",
    sanitizeSegment(meetingId, "unknown-meeting"),
    sanitizeSegment(sessionId, "unknown-session"),
    ...storage.dirParts,
    storage.fileName,
  ].join("/");
};

const enrichManifest = (manifest, manifestPath) => {
  if (!manifest) return manifest;
  const capturePath =
    manifest.capturePath ||
    path.relative(capturesRoot, path.dirname(manifestPath));
  return {
    ...manifest,
    capturePath,
    captureBaseUrl: buildCaptureBaseUrl(capturePath),
    captureSummary: manifest.captureSummary || buildCaptureSummary(manifest),
  };
};

const buildSessionCsv = (manifest) => {
  const events = manifest.events || [];
  const sessionStart = events.reduce((min, e) => (e.at && e.at < min ? e.at : min), Infinity);
  const sessionEnd = events.reduce((max, e) => (e.at && e.at > max ? e.at : max), 0);
  const sessionDurationS = sessionStart < sessionEnd ? ((sessionEnd - sessionStart) / 1000).toFixed(1) : "0";

  // Build per-(streamId, kind) aggregate rows
  const streams = new Map(); // key → stats object
  for (const event of events) {
    if (event.type !== "chunk") continue;
    const m = event.metadata || event.payload || {};
    if (!m.streamId || !m.kind) continue;
    const key = `${m.streamId}::${m.kind}`;
    if (!streams.has(key)) {
      streams.set(key, {
        stream_id: m.streamId,
        kind: m.kind,
        role: m.mediaRole || "",
        participant_id: "",
        owner_id: m.ownerId || "",
        chunks: 0,
        duration_s: 0,
        first_at_ms: Infinity,
        last_at_ms: 0,
        init_chunks: 0,
        total_kb: 0,
      });
    }
    const row = streams.get(key);
    // prefer most-recent non-raw-id participantId as the display name
    if (m.participantId && m.participantId !== m.streamId) row.participant_id = m.participantId;
    if (m.ownerId && !row.owner_id) row.owner_id = m.ownerId;
    row.chunks += 1;
    row.duration_s += Number(m.durationMs || 0) / 1000;
    if (event.at < row.first_at_ms) row.first_at_ms = event.at;
    if (event.at > row.last_at_ms) row.last_at_ms = event.at;
    if (m.initChunk) row.init_chunks += 1;
    row.total_kb += Math.round((m.byteSize || 0) / 1024);
  }

  const csvRows = [];

  // ── metadata header ──────────────────────────────────────────────────────
  csvRows.push(`# session_id: ${manifest.sessionId || ""}`);
  csvRows.push(`# meeting_id: ${manifest.meetingId || ""}`);
  csvRows.push(`# mentor:     ${manifest.mentorLabel || ""}`);
  csvRows.push(`# duration:   ${sessionDurationS}s`);
  csvRows.push(`# generated:  ${new Date().toISOString()}`);
  csvRows.push("");

  // ── column headers ────────────────────────────────────────────────────────
  csvRows.push("stream_id,kind,role,participant_id,owner_id,chunks,duration_s,first_at_s,last_at_s,init_chunks,recorder_restarts,total_kb");

  // ── data rows sorted by first appearance ─────────────────────────────────
  const sorted = Array.from(streams.values()).sort((a, b) => a.first_at_ms - b.first_at_ms);
  for (const row of sorted) {
    const firstS = sessionStart < Infinity ? ((row.first_at_ms - sessionStart) / 1000).toFixed(1) : "";
    const lastS = sessionStart < Infinity ? ((row.last_at_ms - sessionStart) / 1000).toFixed(1) : "";
    const recorderRestarts = Math.max(0, row.init_chunks - 1);
    const durationRounded = row.duration_s.toFixed(1);
    const cols = [
      row.stream_id,
      row.kind,
      row.role,
      row.participant_id || row.stream_id,
      row.owner_id || "",
      row.chunks,
      durationRounded,
      firstS,
      lastS,
      row.init_chunks,
      recorderRestarts,
      row.total_kb,
    ];
    csvRows.push(cols.join(","));
  }

  return csvRows.join("\n") + "\n";
};

const appendManifestEvents = async (sessionDir, sessionInfo, savedEvents) => {
  const manifestPath = path.join(sessionDir, "manifest.json");
  const existing = await readManifest(manifestPath);
  const manifest =
    existing ||
    {
      formatVersion: 2,
      ...sessionInfo,
      startedAt: new Date().toISOString(),
      updatedAt: null,
      eventCount: 0,
      events: [],
    };

  manifest.updatedAt = new Date().toISOString();
  manifest.eventCount += savedEvents.length;
  manifest.events.push(...savedEvents);
  manifest.participantsSeen = manifest.participantsSeen || sessionInfo.participantsSeen || [];
  manifest.trackStats = sessionInfo.trackStats || manifest.trackStats || {};
  manifest.uploadAttempts = sessionInfo.uploadAttempts || manifest.uploadAttempts || 0;
  manifest.captureRole = sessionInfo.captureRole || manifest.captureRole || "mentor";
  manifest.mentorLabel = sessionInfo.mentorLabel || manifest.mentorLabel || "";
  manifest.manualParticipantOverrides = sessionInfo.manualParticipantOverrides || manifest.manualParticipantOverrides || {};
  manifest.capturePath = sessionInfo.capturePath || manifest.capturePath || path.relative(capturesRoot, sessionDir);
  manifest.captureSummary = buildCaptureSummary(manifest);

  await writeJson(manifestPath, manifest);

  // Keep a human-readable CSV breakdown up to date alongside the manifest
  try {
    const csvPath = path.join(sessionDir, "session-breakdown.csv");
    await writeFile(csvPath, buildSessionCsv(manifest), "utf8");
  } catch (e) {
    console.warn("[CSV] Failed to write session-breakdown.csv:", e.message);
  }

  return manifest;
};

const saveEvent = async (sessionDir, event, index) => {
  const payload = event.payload || {};
  const timestamp = Number(event.at || Date.now());
  const streamId = sanitizeSegment(payload.streamId, "stream");
  const baseName = `${timestamp}-${streamId}-${String(index).padStart(4, "0")}`;
  const saved = {
    type: event.type,
    at: timestamp,
    pageUrl: event.pageUrl,
    streamId: payload.streamId,
    targetKey: payload.targetKey,
    remoteTrackId: payload.remoteTrackId,
    files: {},
    metadata: {},
  };

  if (payload.participant) {
    saved.participant = payload.participant;
  }

  if (event.type === "chunk") {
    if (payload.storageKey || payload.s3Key) {
      // Direct storage upload — binary already in storage, store key reference only
      saved.files.recording = payload.storageKey || payload.s3Key;
      saved.metadata = {
        streamId: payload.streamId,
        participantId: payload.participantId,
        kind: payload.kind,
        mediaRole: payload.mediaRole,
        trackSource: payload.trackSource,
        mimeType: payload.mimeType || "",
        chunkStartedAt: Number(payload.chunkStartedAt || 0) || null,
        chunkEndedAt: Number(payload.chunkEndedAt || 0) || null,
        durationMs: Number(payload.durationMs || 0),
        initChunk: Boolean(payload.initChunk),
        index: Number(payload.index || 0),
        byteSize: Number(payload.byteSize || 0),
        uploadedDirectly: true,
      };
    } else if (payload.data) {
      const { buffer, mimeType } = parseDataUrl(payload.data);
      const storage = getChunkStorageInfo(payload, baseName);
      const chunkDir = path.join(sessionDir, ...storage.dirParts);

      await mkdir(chunkDir, { recursive: true });

      const extension = mimeType.includes("webm") ? "webm" : "bin";
      const fileName = storage.fileName.replace(/\.webm$|\.bin$/i, `.${extension}`);
      const chunkPath = path.join(chunkDir, fileName);
      await writeFile(chunkPath, buffer);

      saved.files.recording = path.relative(sessionDir, chunkPath);
      saved.metadata = {
        streamId: payload.streamId,
        participantId: payload.participantId,
        kind: payload.kind,
        mediaRole: payload.mediaRole,
        trackSource: payload.trackSource,
        mimeType: payload.mimeType || mimeType,
        chunkStartedAt: Number(payload.chunkStartedAt || 0) || null,
        chunkEndedAt: Number(payload.chunkEndedAt || 0) || null,
        durationMs: Number(payload.durationMs || 0),
        initChunk: Boolean(payload.initChunk),
        index: Number(payload.index || 0),
        byteSize: buffer.byteLength,
      };
    } else {
      saved.metadata = {
        streamId: payload.streamId,
        participantId: payload.participantId,
        kind: payload.kind,
        mediaRole: payload.mediaRole,
        trackSource: payload.trackSource,
        mimeType: payload.mimeType || "",
        chunkStartedAt: Number(payload.chunkStartedAt || 0) || null,
        chunkEndedAt: Number(payload.chunkEndedAt || 0) || null,
        durationMs: Number(payload.durationMs || 0),
        initChunk: Boolean(payload.initChunk),
        index: Number(payload.index || 0),
      };
    }

    return saved;
  }

  if (event.type === "remote-video-frame") {
    const frameDir = path.join(sessionDir, "frames");

    await mkdir(frameDir, { recursive: true });

    if (payload.thumbnailDataUrl) {
      const { buffer } = parseDataUrl(payload.thumbnailDataUrl);
      const thumbnailPath = path.join(frameDir, `${baseName}.jpg`);

      await writeFile(thumbnailPath, buffer);
      saved.files.thumbnail = path.relative(sessionDir, thumbnailPath);
    }

    if (payload.rgbaDataUrl) {
      const { buffer } = parseDataUrl(payload.rgbaDataUrl);
      const rawPath = path.join(frameDir, `${baseName}.rgba`);

      await writeFile(rawPath, buffer);
      saved.files.rgba = path.relative(sessionDir, rawPath);
      saved.metadata.rawByteSize = buffer.byteLength;
    }

    saved.metadata = {
      ...saved.metadata,
      width: payload.displayWidth,
      height: payload.displayHeight,
      allocationSize: payload.allocationSize,
      checksum: payload.checksum,
      trackKind: payload.trackKind,
      trackSource: payload.trackSource,
      sourceFormat: payload.sourceFormat,
      copiedFormat: payload.copiedFormat,
      rawSource: payload.rawSource,
      track: payload.track,
      targetKey: payload.targetKey,
      remoteTrackId: payload.remoteTrackId,
    };
    return saved;
  }

  if (event.type === "remote-audio-recording" || event.type === "local-audio-recording") {
    const audioDir = path.join(sessionDir, "audio");

    await mkdir(audioDir, { recursive: true });

    const samplesPath = path.join(audioDir, `${baseName}.json`);
    const float32Path = path.join(audioDir, `${baseName}.f32`);

    await writeJson(samplesPath, {
      sampleRate: payload.sampleRate,
      channels: payload.channels,
      sampleCount: payload.sampleCount,
      samples: payload.samples || [],
    });
    await writeFile(float32Path, decodeNumberArray(payload.samples, 4));

    saved.files.samples = path.relative(sessionDir, samplesPath);
    saved.files.float32 = path.relative(sessionDir, float32Path);
    saved.metadata = {
      sampleRate: payload.sampleRate,
      channels: payload.channels,
      sampleCount: payload.sampleCount,
      trackKind: payload.trackKind,
      trackSource: payload.trackSource,
      track: payload.track,
      targetKey: payload.targetKey,
      remoteTrackId: payload.remoteTrackId,
    };
    return saved;
  }

  if (event.type === "remote-media-recording" || event.type === "local-media-recording") {
    const recordingDir = path.join(sessionDir, "recordings");

    await mkdir(recordingDir, { recursive: true });

    if (payload.dataUrl) {
      const { buffer, mimeType } = parseDataUrl(payload.dataUrl);
      const extension = mimeType.includes("webm") ? "webm" : "bin";
      const recordingPath = path.join(recordingDir, `${baseName}.${extension}`);

      await writeFile(recordingPath, buffer);
      saved.files.recording = path.relative(sessionDir, recordingPath);
      saved.metadata.byteSize = buffer.byteLength;
    }

    saved.metadata = {
      ...saved.metadata,
      mimeType: payload.mimeType,
      size: payload.size,
      durationMs: payload.durationMs,
      chunkIndex: payload.chunkIndex,
      hasAudio: payload.hasAudio,
      hasVideo: payload.hasVideo,
      trackKind: payload.trackKind,
      trackSource: payload.trackSource,
      recordingKind: payload.recordingKind,
      isPlayableCandidate: payload.isPlayableCandidate,
      droppedReason: payload.droppedReason,
      targetKey: payload.targetKey,
      remoteTrackId: payload.remoteTrackId,
    };
    return saved;
  }

  const eventDir = path.join(sessionDir, "events");

  await mkdir(eventDir, { recursive: true });

  const eventPath = path.join(eventDir, `${baseName}-${sanitizeSegment(event.type, "event")}.json`);

  await writeJson(eventPath, event);
  saved.files.event = path.relative(sessionDir, eventPath);
  saved.metadata = payload;

  return saved;
};

const findManifests = async (directory) => {
  const manifests = [];

  try {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        manifests.push(...(await findManifests(entryPath)));
      } else if (entry.name === "manifest.json") {
        manifests.push(entryPath);
      }
    }
  } catch {
    return manifests;
  }

  return manifests;
};

const getDiskUsageBytes = () =>
  new Promise((resolve) => {
    execFile("du", ["-sb", capturesRoot], (_err, stdout) => {
      resolve(parseInt(stdout?.split("\t")[0], 10) || 0);
    });
  });

app.get("/health", (_request, response) => {
  response.json({ ok: true, capturesRoot });
});

app.get("/dashboard", (_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meet Capture — Benchmark Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
  h1 { font-size: 1.1rem; font-weight: 600; color: #94a3b8; margin-bottom: 20px; letter-spacing: .05em; text-transform: uppercase; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1e293b; border-radius: 10px; padding: 16px 20px; }
  .card .label { font-size: .72rem; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
  .card .value { font-size: 1.8rem; font-weight: 700; color: #f1f5f9; }
  .card .value.error { color: #f87171; }
  .card .value.ok { color: #34d399; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
  .chart-box { background: #1e293b; border-radius: 10px; padding: 16px 20px; }
  .chart-box h2 { font-size: .75rem; color: #64748b; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 12px; }
  .status-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; font-size: .8rem; color: #64748b; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #34d399; animation: pulse 2s infinite; }
  .dot.offline { background: #f87171; animation: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .reset-btn { margin-left: auto; padding: 4px 14px; background: #1e293b; border: 1px solid #334155; color: #94a3b8; border-radius: 6px; font-size: .75rem; cursor: pointer; transition: .15s; }
  .reset-btn:hover { background: #ef4444; border-color: #ef4444; color: #fff; }
</style>
</head>
<body>
<h1>Meet Capture — Benchmark Dashboard</h1>
<div class="status-bar"><div class="dot" id="dot"></div><span id="status">Connecting…</span><button class="reset-btn" onclick="resetStats()">Reset Stats</button></div>
<div class="cards">
  <div class="card"><div class="label">Uptime</div><div class="value" id="c-uptime">—</div></div>
  <div class="card"><div class="label">CPU</div><div class="value" id="c-cpu">—</div></div>
  <div class="card"><div class="label">RAM (RSS)</div><div class="value" id="c-ram">—</div></div>
  <div class="card"><div class="label">Batches</div><div class="value" id="c-batches">—</div></div>
  <div class="card"><div class="label">Events</div><div class="value" id="c-events">—</div></div>
  <div class="card"><div class="label">Received</div><div class="value" id="c-mb">—</div></div>
  <div class="card"><div class="label">Files saved</div><div class="value" id="c-files">—</div></div>
  <div class="card"><div class="label">Disk used</div><div class="value" id="c-disk">—</div></div>
  <div class="card"><div class="label">S3 uploads</div><div class="value ok" id="c-s3">—</div></div>
  <div class="card"><div class="label">Errors</div><div class="value error" id="c-errors">—</div></div>
</div>
<div class="charts">
  <div class="chart-box"><h2>CPU %</h2><canvas id="ch-cpu"></canvas></div>
  <div class="chart-box"><h2>RAM used (MB)</h2><canvas id="ch-ram"></canvas></div>
  <div class="chart-box"><h2>Batches / interval</h2><canvas id="ch-batches"></canvas></div>
  <div class="chart-box"><h2>Events / interval</h2><canvas id="ch-events"></canvas></div>
  <div class="chart-box"><h2>MB received / interval</h2><canvas id="ch-mb"></canvas></div>
  <div class="chart-box"><h2>Disk used (MB)</h2><canvas id="ch-disk"></canvas></div>
</div>
<script>
const POLL_MS = 10_000;
const MAX_POINTS = 40;
const labels = [];
let prev = null;

const mkChart = (id, color) => new Chart(document.getElementById(id), {
  type: "line",
  data: { labels, datasets: [{ data: [], borderColor: color, backgroundColor: color + "22", fill: true, tension: .35, pointRadius: 2 }] },
  options: { animation: false, plugins: { legend: { display: false } }, scales: {
    x: { ticks: { color: "#475569", maxTicksLimit: 6 }, grid: { color: "#1e293b" } },
    y: { ticks: { color: "#475569" }, grid: { color: "#334155" }, beginAtZero: true }
  }}
});

const charts = {
  cpu:     mkChart("ch-cpu",     "#f472b6"),
  ram:     mkChart("ch-ram",     "#a78bfa"),
  batches: mkChart("ch-batches", "#818cf8"),
  events:  mkChart("ch-events",  "#34d399"),
  mb:      mkChart("ch-mb",      "#f59e0b"),
  disk:    mkChart("ch-disk",    "#38bdf8"),
};

const push = (chart, value) => {
  chart.data.datasets[0].data.push(value);
  if (chart.data.datasets[0].data.length > MAX_POINTS) chart.data.datasets[0].data.shift();
  chart.update("none");
};

const fmt = (s) => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h ? h+"h "+m+"m" : m ? m+"m "+sec+"s" : sec+"s"; };
const mb  = (b) => (b/1048576).toFixed(1) + " MB";

const poll = async () => {
  try {
    const res = await fetch("/api/stats");
    const d   = await res.json();
    const now = new Date().toLocaleTimeString();

    document.getElementById("dot").classList.remove("offline");
    document.getElementById("status").textContent = "Live · last update " + now + " · polling every " + (POLL_MS/1000) + "s";

    document.getElementById("c-uptime").textContent  = fmt(d.uptimeSeconds);
    document.getElementById("c-cpu").textContent     = (d.cpuPercent || 0).toFixed(1) + "%";
    document.getElementById("c-ram").textContent     = (d.memRssMB || 0) + " MB";
    document.getElementById("c-batches").textContent = d.totalBatchRequests;
    document.getElementById("c-events").textContent  = d.totalEvents;
    document.getElementById("c-mb").textContent      = mb(d.totalBytesReceived);
    document.getElementById("c-files").textContent   = d.totalSavedFiles;
    document.getElementById("c-disk").textContent    = mb(d.diskUsageBytes);
    document.getElementById("c-s3").textContent      = d.totalS3Uploads + (d.totalS3Errors > 0 ? " (" + d.totalS3Errors + " err)" : "");
    document.getElementById("c-s3").className        = "value " + (d.totalS3Errors > 0 ? "error" : "ok");
    document.getElementById("c-errors").textContent  = d.totalErrors;
    document.getElementById("c-errors").className    = "value " + (d.totalErrors > 0 ? "error" : "ok");

    if (labels.length >= MAX_POINTS) labels.shift();
    labels.push(now);

    push(charts.cpu,     +(d.cpuPercent || 0).toFixed(1));
    push(charts.ram,     d.memRssMB || 0);
    push(charts.batches, prev ? d.totalBatchRequests - prev.totalBatchRequests : 0);
    push(charts.events,  prev ? d.totalEvents - prev.totalEvents : 0);
    push(charts.mb,      prev ? +((d.totalBytesReceived - prev.totalBytesReceived)/1048576).toFixed(2) : 0);
    push(charts.disk,    +(d.diskUsageBytes/1048576).toFixed(1));

    prev = d;
  } catch {
    document.getElementById("dot").classList.add("offline");
    document.getElementById("status").textContent = "Offline · retrying…";
  }
};

const resetStats = async () => {
  if (!confirm("Reset all counters to 0?")) return;
  await fetch("/api/stats/reset", { method: "POST" });
  prev = null;
  poll();
};

poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`);
});

app.get("/api/stats", async (_request, response, next) => {
  try {
    const diskUsageBytes = await getDiskUsageBytes();
    const memRssMB = +(process.memoryUsage().rss / 1048576).toFixed(1);
    response.json({
      ok: true,
      uptimeSeconds: Math.floor((Date.now() - serverStartMs) / 1000),
      cpuPercent: +cpuPercent.toFixed(1),
      memRssMB,
      ...counters,
      activeSessionCount: activeSessions.size,
      diskUsageBytes,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/stats/reset", (_request, response) => {
  for (const key of Object.keys(counters)) counters[key] = 0;
  response.json({ ok: true, resetAt: new Date().toISOString() });
});

app.post("/api/capture/presign", async (request, response, next) => {
  if (!isStorageConfigured()) return response.status(503).json({ ok: false, reason: "Storage not configured" });
  try {
    const body = request.body || {};
    const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
    const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
    const chunks = Array.isArray(body.chunks) ? body.chunks : [];

    const presignedUrls = await Promise.all(
      chunks.map(async (chunk) => {
        const timestamp = Math.floor(Number(chunk.eventAt || Date.now()));
        const streamId = sanitizeSegment(chunk.streamId || "", "stream");
        const padded = String(Number(chunk.index ?? 0)).padStart(4, "0");
        const baseName = `${timestamp}-${streamId}-${padded}`;
        const storageKey = buildChunkStorageKey(meetingId, sessionId, chunk, baseName);
        const mimeType = String(chunk.mimeType || "video/webm");
        const { uploadUrl } = await generateUploadUrl(storageKey, mimeType, 300);
        return { storageKey, uploadUrl, expiresAt: Date.now() + 295_000 };
      }),
    );

    response.json({ ok: true, presignedUrls });
  } catch (err) {
    next(err);
  }
});

app.post("/api/capture/batch", async (request, response, next) => {
  const batchStartMs = Date.now();
  const bytesReceived = Number(request.headers["content-length"] || 0);
  counters.totalBatchRequests += 1;

  try {
    const body = request.body || {};
    const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
    const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
    const events = Array.isArray(body.events) ? body.events : [];
    const sessionDir = path.join(capturesRoot, meetingId, sessionId);
    const capturePath = buildCapturePath(meetingId, sessionId);

    await mkdir(sessionDir, { recursive: true });
    activeSessions.add(sessionId);

    const savedEvents = [];

    for (let index = 0; index < events.length; index += 1) {
      savedEvents.push(await saveEvent(sessionDir, events[index], index));
    }

    const manifest = await appendManifestEvents(
      sessionDir,
      {
        meetingId,
        sessionId,
        captureRole: sanitizeSegment(body.captureRole, "mentor"),
        mentorLabel: String(body.mentorLabel || "").trim(),
        pageUrl: body.pageUrl,
        userAgent: body.userAgent,
        capturePath,
        participantsSeen: Array.isArray(body.capturedParticipants) ? body.capturedParticipants : [],
        manualParticipantOverrides: body.manualParticipantOverrides || {},
        trackStats: body.trackStats || {},
        uploadAttempts: Number(body.uploadAttempts || 0),
      },
      savedEvents,
    );

    const savedFileCount = savedEvents.reduce((n, e) => n + Object.keys(e.files || {}).length, 0);
    counters.totalEvents += savedEvents.length;
    counters.totalBytesReceived += bytesReceived;
    counters.totalSavedFiles += savedFileCount;

    console.log(
      `[BATCH] session=${sessionId} events=${savedEvents.length} ` +
      `bytes=${(bytesReceived / 1048576).toFixed(2)}MB ` +
      `processingMs=${Date.now() - batchStartMs} savedFiles=${savedFileCount}`,
    );

    // Fire-and-forget storage upload — max 4 concurrent to avoid CPU spikes (legacy base64 path)
    if (isStorageConfigured()) {
      const localPaths = savedEvents.flatMap((e) =>
        Object.values(e.files || {})
          .filter((f) => !String(f).startsWith("captures/") && !String(f).endsWith(".json"))
          .map((f) => ({ local: path.join(sessionDir, f), storageKey: `captures/${buildCapturePath(meetingId, sessionId)}/${f}` })),
      );
      const queue = localPaths.slice();
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item) await uploadFileAndDelete(item.local, item.storageKey).then((bytes) => {
            counters.totalS3Uploads += 1;
            counters.totalS3BytesUploaded += bytes;
          }).catch((err) => {
            counters.totalS3Errors += 1;
            console.error(`[Storage] Upload failed ${path.relative(capturesRoot, item.local)}: ${err.message}`);
          });
        }
      });
      Promise.all(workers).then(() => {
        if (localPaths.length > 0) {
          console.log(`[Storage] Uploaded ${localPaths.length} files for session=${sessionId}`);
        }
      });
    }

    response.json({
      ok: true,
      meetingId,
      sessionId,
      savedEventCount: savedEvents.length,
      totalEventCount: manifest.eventCount,
      sessionPath: path.relative(projectRoot, sessionDir),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions", async (_request, response, next) => {
  try {
    const manifestPaths = await findManifests(capturesRoot);
    const sessions = [];

    for (const manifestPath of manifestPaths) {
      const manifest = await readManifest(manifestPath);
      const stats = await stat(manifestPath);

      if (manifest) {
        sessions.push({
          meetingId: manifest.meetingId,
          sessionId: manifest.sessionId,
          captureRole: manifest.captureRole,
          mentorLabel: manifest.mentorLabel,
          startedAt: manifest.startedAt,
          updatedAt: manifest.updatedAt,
          eventCount: manifest.eventCount,
          captureSummary: manifest.captureSummary || null,
          capturePath: manifest.capturePath || path.relative(capturesRoot, path.dirname(manifestPath)),
          manifestPath: path.relative(capturesRoot, manifestPath),
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    }

    sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    response.json({ ok: true, sessions });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:sessionId", async (request, response, next) => {
  try {
    const manifestPaths = await findManifests(capturesRoot);
    const target = sanitizeSegment(request.params.sessionId, "");

    for (const manifestPath of manifestPaths) {
      const manifest = enrichManifest(await readManifest(manifestPath), manifestPath);

      if (manifest?.sessionId === target) {
        const signedEvents = await signEventFiles(manifest.events || [], manifest.capturePath);
        response.json({ ok: true, session: { ...manifest, events: signedEvents } });
        return;
      }
    }

    response.status(404).json({ ok: false, reason: "Session not found" });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  counters.totalErrors += 1;
  console.error(error);
  response.status(500).json({ ok: false, reason: error.message });
});

await mkdir(capturesRoot, { recursive: true });

const benchmarkCsvPath = path.join(
  projectRoot,
  `benchmark-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.csv`,
);
const CSV_HEADER = "time,uptimeSeconds,cpuPercent,memRssMB,totalBatchRequests,totalEvents,totalMBReceived,totalErrors,totalSavedFiles,totalS3Uploads,totalS3Errors,totalS3BytesMB,activeSessionCount,diskUsageMB\n";
await writeFile(benchmarkCsvPath, CSV_HEADER);

const writeBenchmarkRow = async () => {
  const diskUsageBytes = await getDiskUsageBytes();
  const memRssMB = (process.memoryUsage().rss / 1048576).toFixed(1);
  const row =
    `${new Date().toISOString()},` +
    `${Math.floor((Date.now() - serverStartMs) / 1000)},` +
    `${cpuPercent.toFixed(1)},` +
    `${memRssMB},` +
    `${counters.totalBatchRequests},` +
    `${counters.totalEvents},` +
    `${(counters.totalBytesReceived / 1048576).toFixed(2)},` +
    `${counters.totalErrors},` +
    `${counters.totalSavedFiles},` +
    `${counters.totalS3Uploads},` +
    `${counters.totalS3Errors},` +
    `${(counters.totalS3BytesUploaded / 1048576).toFixed(2)},` +
    `${activeSessions.size},` +
    `${(diskUsageBytes / 1048576).toFixed(2)}\n`;
  await appendFile(benchmarkCsvPath, row);
};

setInterval(writeBenchmarkRow, 30_000);

app.listen(port, host, () => {
  console.log(`Meet capture API listening on http://${host}:${port}`);
  console.log(`Captures root: ${capturesRoot}`);
  console.log(`Benchmark CSV: ${benchmarkCsvPath}`);
});
