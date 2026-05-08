import cors from "cors";
import express from "express";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const capturesRoot = path.join(projectRoot, "captures");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8787);

const app = express();

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

const appendManifestEvents = async (sessionDir, sessionInfo, savedEvents) => {
  const manifestPath = path.join(sessionDir, "manifest.json");
  const existing = await readManifest(manifestPath);
  const manifest =
    existing ||
    {
      formatVersion: 1,
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

  await writeJson(manifestPath, manifest);

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
    files: {},
    metadata: {},
  };

  if (payload.participant) {
    saved.participant = payload.participant;
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
      hasAudio: payload.hasAudio,
      hasVideo: payload.hasVideo,
      trackKind: payload.trackKind,
      trackSource: payload.trackSource,
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

app.get("/health", (_request, response) => {
  response.json({ ok: true, capturesRoot });
});

app.post("/api/capture/batch", async (request, response, next) => {
  try {
    const body = request.body || {};
    const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
    const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
    const events = Array.isArray(body.events) ? body.events : [];
    const sessionDir = path.join(capturesRoot, meetingId, sessionId);

    await mkdir(sessionDir, { recursive: true });

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
        participantsSeen: Array.isArray(body.capturedParticipants) ? body.capturedParticipants : [],
        trackStats: body.trackStats || {},
        uploadAttempts: Number(body.uploadAttempts || 0),
      },
      savedEvents,
    );

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
      const manifest = await readManifest(manifestPath);

      if (manifest?.sessionId === target) {
        response.json({ ok: true, session: manifest });
        return;
      }
    }

    response.status(404).json({ ok: false, reason: "Session not found" });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ ok: false, reason: error.message });
});

await mkdir(capturesRoot, { recursive: true });

app.listen(port, host, () => {
  console.log(`Meet capture API listening on http://${host}:${port}`);
  console.log(`Captures root: ${capturesRoot}`);
});
