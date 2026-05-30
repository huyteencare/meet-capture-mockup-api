import cors from "cors";
import { createAttendanceIdentityProbe } from "./attendanceIdentityProbe.js";
import { isConfigured as isStorageConfigured } from "./storage.js";
import { createCaptureRouter } from "./routes/capture.js";
import { createDashboardRouter } from "./routes/dashboard.js";
import { createDebugRouter } from "./routes/debug.js";
import { createCheckinRouter } from "./routes/checkin.js";
import { createLinkRouter } from "./routes/link.js";
import { createAutoCheckinRouter } from "./routes/auto-checkin.js";
import { createSessionsRouter } from "./routes/sessions.js";
import express from "express";
import morgan from "morgan";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const buildCapturePath = (meetingId, sessionId) => path.join(meetingId, sessionId);

export const sanitizeSegment = (value, fallback) => {
  const sanitized = String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);
  return sanitized || fallback;
};

const parseDataUrl = (dataUrl) => {
  const value = String(dataUrl || "");
  if (!value.startsWith("data:")) throw new Error("Invalid data URL");
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) throw new Error("Invalid data URL");
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
  if (!Array.isArray(values)) return Buffer.alloc(0);
  if (bytesPerValue === 4) {
    const buffer = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => buffer.writeFloatLE(Number(value) || 0, index * 4));
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

const buildCaptureBaseUrl = (capturePath) =>
  `/captures/${capturePath.split(path.sep).map(encodeURIComponent).join("/")}`;

const getEventMeta = (event) => event?.metadata || event?.payload || {};

const formatDurationMs = (durationMs) => {
  const totalMs = Math.max(0, Number(durationMs || 0));
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

export const getDiskUsageBytes = (capturesRoot) =>
  new Promise((resolve) => {
    execFile("du", ["-sb", capturesRoot], (_err, stdout) => {
      resolve(parseInt(stdout?.split("\t")[0], 10) || 0);
    });
  });

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
    if (meta?.streamId && meta?.name) nameByStreamId[String(meta.streamId)] = String(meta.name);
  }
  return nameByStreamId;
};

const resolveStudentName = (streamId, meta, nameByStreamId) => {
  const streamKey = String(streamId || "").trim();
  if (streamKey && nameByStreamId[streamKey]) return nameByStreamId[streamKey];
  const participantId = String(meta?.participantId || "").trim();
  if (participantId && participantId !== streamKey && !participantId.startsWith("__")) return participantId;
  return streamKey || "unknown";
};

const buildCaptureSummary = (manifest) => {
  const nameByStreamId = buildNameByStreamId(manifest);
  // streamId → student entry. Stable key so name changes don't create duplicate entries.
  const students = new Map();

  for (const event of manifest.events || []) {
    const meta = getEventMeta(event);
    const streamId = meta?.streamId;
    if (!streamId || meta?.mediaRole !== "student-video") continue;
    const ownerId = String(meta?.ownerId || "").trim();
    const participantName = resolveStudentName(streamId, meta, nameByStreamId);
    if (!participantName || participantName === "unknown") continue;

    const groupKey = String(streamId);

    if (!students.has(groupKey)) {
      students.set(groupKey, {
        ownerId: ownerId || null, participantName, streamIds: new Set(),
        joinObservedAt: Number(event.at || 0) || null, leaveObservedAt: Number(event.at || 0) || null,
        firstChunkAt: null, lastChunkAt: null, actualVideoDurationMs: 0, videoChunkCount: 0,
      });
    }
    const summary = students.get(groupKey);
    if (!summary.ownerId && ownerId) summary.ownerId = ownerId;
    // Prefer a human-readable name over the raw numeric streamId
    const isCurrentRaw = /^\d+$/.test(summary.participantName);
    if (isCurrentRaw && participantName !== groupKey) summary.participantName = participantName;
    const eventAt = Number(event.at || 0) || null;
    summary.streamIds.add(groupKey);
    if (eventAt) {
      summary.joinObservedAt = summary.joinObservedAt ? Math.min(summary.joinObservedAt, eventAt) : eventAt;
      summary.leaveObservedAt = summary.leaveObservedAt ? Math.max(summary.leaveObservedAt, eventAt) : eventAt;
    }
    if (event.type === "chunk") {
      summary.videoChunkCount += 1;
      summary.actualVideoDurationMs += Math.max(0, Number(meta.durationMs || 0));
      if (eventAt) {
        summary.firstChunkAt = summary.firstChunkAt ? Math.min(summary.firstChunkAt, eventAt) : eventAt;
        summary.lastChunkAt = summary.lastChunkAt ? Math.max(summary.lastChunkAt, eventAt) : eventAt;
      }
    }
  }

  const participants = Array.from(students.values())
    .filter((s) => s.videoChunkCount > 0)
    .map((s) => ({
      ownerId: s.ownerId || null, participantName: s.participantName,
      streamIds: Array.from(s.streamIds),
      joinObservedAt: s.joinObservedAt, leaveObservedAt: s.leaveObservedAt,
      firstChunkAt: s.firstChunkAt, lastChunkAt: s.lastChunkAt,
      actualVideoDurationMs: s.actualVideoDurationMs,
      actualVideoDurationLabel: formatDurationMs(s.actualVideoDurationMs),
      videoChunkCount: s.videoChunkCount,
    }))
    .sort((a, b) => Number(a.joinObservedAt || 0) - Number(b.joinObservedAt || 0));

  return {
    studentVideoParticipants: participants,
    totals: {
      studentCount: participants.length,
      totalVideoChunkCount: participants.reduce((s, p) => s + p.videoChunkCount, 0),
      totalActualVideoDurationMs: participants.reduce((s, p) => s + p.actualVideoDurationMs, 0),
      totalActualVideoDurationLabel: formatDurationMs(participants.reduce((s, p) => s + p.actualVideoDurationMs, 0)),
    },
  };
};

const normalizeAttendanceCandidate = (candidate = {}) => {
  const evidence = candidate.evidence && typeof candidate.evidence === "object" && !Array.isArray(candidate.evidence) ? candidate.evidence : {};
  const candidateId = String(candidate.candidateId || "").trim().slice(0, 240);
  const participantDisplayName = String(candidate.participantDisplayName || "").trim().slice(0, 255);
  const displayName = String(candidate.displayName || "").trim().slice(0, 255) || participantDisplayName || "unknown";
  const provisionalParticipantKey = String(candidate.provisionalParticipantKey || "").trim().slice(0, 255) || null;
  const canonicalIdentityType = String(candidate.canonicalIdentityType || "").trim().slice(0, 64) || null;
  const canonicalIdentityValue = String(candidate.canonicalIdentityValue || "").trim().slice(0, 240) || null;
  const matchType = String(candidate.matchType || "").trim() === "confident_present" ? "confident_present" : "mismatch_review";
  const confidence = Math.max(0, Math.min(1, Number(candidate.confidence || 0)));
  const joinObservedAt = String(candidate.joinObservedAt || "").trim();
  const leaveObservedAt = candidate.leaveObservedAt ? String(candidate.leaveObservedAt).trim() : null;
  if (!candidateId || !participantDisplayName || !joinObservedAt) return null;
  return {
    candidateId,
    matchType,
    confidence,
    participantDisplayName,
    displayName,
    provisionalParticipantKey,
    canonicalIdentityType,
    canonicalIdentityValue,
    joinObservedAt,
    leaveObservedAt,
    evidence
  };
};

const mergeAttendanceCandidates = (existingCandidates = [], incomingCandidates = []) => {
  const merged = new Map();
  for (const c of existingCandidates) { const n = normalizeAttendanceCandidate(c); if (n) merged.set(n.candidateId, n); }
  for (const c of incomingCandidates) { const n = normalizeAttendanceCandidate(c); if (n) merged.set(n.candidateId, n); }
  return Array.from(merged.values()).sort((a, b) => new Date(a.joinObservedAt).getTime() - new Date(b.joinObservedAt).getTime());
};

const normalizeIdentityProbeResult = (result = {}) => {
  const candidate = result.candidate || {};
  const matchedParticipant = result.matchedParticipant || {};
  const identitySignals = result.identitySignals || {};
  const candidateId = String(candidate.candidateId || "").trim().slice(0, 240);
  if (!candidateId) return null;
  const signedinUserUser = String(identitySignals.signedinUserUser || matchedParticipant.signedinUserUser || "").trim().slice(0, 240) || null;
  const probeStatus = String(result.matchOutcome || result.finalVerdict || "unknown").trim().slice(0, 64) || "unknown";
  const canBindCanonicalIdentity = probeStatus === "matched_signedin_user" && !!signedinUserUser;
  return {
    candidateId,
    participantDisplayName: String(candidate.participantDisplayName || "").trim().slice(0, 255) || "unknown",
    displayName: String(candidate.displayName || candidate.participantDisplayName || "").trim().slice(0, 255) || "unknown",
    provisionalParticipantKey: String(candidate.provisionalParticipantKey || "").trim().slice(0, 255) || null,
    probeStatus,
    finalVerdict: String(result.finalVerdict || "").trim().slice(0, 64) || null,
    participantType: String(matchedParticipant.participantType || "").trim().slice(0, 64) || null,
    signedinUserUser: canBindCanonicalIdentity ? signedinUserUser : null,
    canonicalIdentityType: canBindCanonicalIdentity ? "signedinUser.user" : null,
    canonicalIdentityValue: canBindCanonicalIdentity ? signedinUserUser : null,
    lastProbedAt: new Date().toISOString(),
    retryScheduled: Boolean(result.retryScheduled),
  };
};

export const updateManifestIdentityProbeResult = (capturesRoot) => async ({ meetingId, sessionId, payload }) => {
  const safeMeetingId = sanitizeSegment(meetingId, "unknown-meeting");
  const safeSessionId = sanitizeSegment(sessionId, "unknown-session");
  if (!safeMeetingId || !safeSessionId) return null;

  const normalized = normalizeIdentityProbeResult(payload);
  if (!normalized) return null;

  const sessionDir = path.join(capturesRoot, safeMeetingId, safeSessionId);
  const manifestPath = path.join(sessionDir, "manifest.json");
  const manifest = await readManifest(manifestPath);
  if (!manifest) return null;

  const existing = Array.isArray(manifest.identityProbeResults) ? manifest.identityProbeResults : [];
  const merged = new Map(existing.map((entry) => [String(entry?.candidateId || ""), entry]).filter(([candidateId]) => !!candidateId));
  merged.set(normalized.candidateId, { ...(merged.get(normalized.candidateId) || {}), ...normalized });
  manifest.identityProbeResults = Array.from(merged.values()).sort((a, b) => String(a.lastProbedAt || "").localeCompare(String(b.lastProbedAt || "")));
  manifest.updatedAt = new Date().toISOString();
  await writeJson(manifestPath, manifest);
  return normalized;
};

const forwardAttendanceCandidates = (webhookUrl, webhookSecret) => async ({ meetingId, sessionId, mentorLabel, candidates }) => {
  if (!webhookUrl || !Array.isArray(candidates) || candidates.length === 0) return 0;
  const normalizedCandidates = candidates.map(normalizeAttendanceCandidate).filter(Boolean);
  if (normalizedCandidates.length === 0) return 0;
  const results = await Promise.allSettled(
    normalizedCandidates.map((candidate) =>
      fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(webhookSecret ? { "x-attendance-draft-secret": webhookSecret } : {}) },
        body: JSON.stringify({ meetingId, captureSessionId: sessionId, participantDisplayName: candidate.participantDisplayName,
          joinObservedAt: candidate.joinObservedAt, leaveObservedAt: candidate.leaveObservedAt,
          confidence: candidate.confidence, matchType: candidate.matchType, mentorLabel,
          evidence: { candidateId: candidate.candidateId, ...candidate.evidence } }),
      }).then(async (res) => {
        if (!res.ok) { const text = await res.text().catch(() => ""); throw new Error(`Webhook ${res.status}: ${text || "failed"}`); }
      }),
    ),
  );
  const failed = results.filter((r) => r.status === "rejected");
  failed.forEach((r) => console.warn("[Attendance Draft] Forward failed:", r.reason?.message || r.reason));
  return normalizedCandidates.length - failed.length;
};

const getChunkStorageInfo = (payload, fallbackBaseName) => {
  const mediaRole = String(payload.mediaRole || "").trim();
  const streamId = sanitizeSegment(payload.streamId, "stream");
  const participantStorageKey = sanitizeSegment(payload.participantStorageKey, "");
  const participantId = sanitizeSegment(payload.participantId, streamId);
  const safeIndex = String(Number(payload.index ?? 0)).padStart(6, "0");
  const baseName = `chunk-${safeIndex}-${fallbackBaseName}`;
  if (mediaRole === "mentor-audio") return { dirParts: ["mentor-audio"], fileName: `${baseName}.webm` };
  if (mediaRole === "shared-audio") return { dirParts: ["shared-audio"], fileName: `${baseName}.webm` };
  if (mediaRole === "student-video") {
    return { dirParts: ["participants", participantStorageKey || participantId, "video"], fileName: `${baseName}.webm` };
  }
  return { dirParts: ["recordings"], fileName: `${fallbackBaseName}.bin` };
};

export const buildChunkStorageKey = (meetingId, sessionId, payload, baseName) => {
  const storage = getChunkStorageInfo(payload, baseName);
  return ["captures", sanitizeSegment(meetingId, "unknown-meeting"), sanitizeSegment(sessionId, "unknown-session"), ...storage.dirParts, storage.fileName].join("/");
};

export const enrichManifest = (capturesRoot) => (manifest, manifestPath) => {
  if (!manifest) return manifest;
  const capturePath = manifest.capturePath || path.relative(capturesRoot, path.dirname(manifestPath));
  return { ...manifest, capturePath, captureBaseUrl: buildCaptureBaseUrl(capturePath), captureSummary: manifest.captureSummary || buildCaptureSummary(manifest) };
};

const buildSessionCsv = (manifest) => {
  const events = manifest.events || [];
  const sessionStart = events.reduce((min, e) => (e.at && e.at < min ? e.at : min), Infinity);
  const sessionEnd = events.reduce((max, e) => (e.at && e.at > max ? e.at : max), 0);
  const sessionDurationS = sessionStart < sessionEnd ? ((sessionEnd - sessionStart) / 1000).toFixed(1) : "0";
  const streams = new Map();
  for (const event of events) {
    if (event.type !== "chunk") continue;
    const m = event.metadata || event.payload || {};
    if (!m.streamId || !m.kind) continue;
    const key = `${m.streamId}::${m.kind}`;
    if (!streams.has(key)) streams.set(key, { stream_id: m.streamId, kind: m.kind, role: m.mediaRole || "", participant_id: "", owner_id: m.ownerId || "", chunks: 0, duration_s: 0, first_at_ms: Infinity, last_at_ms: 0, init_chunks: 0, total_kb: 0 });
    const row = streams.get(key);
    if (m.participantId && m.participantId !== m.streamId) row.participant_id = m.participantId;
    if (m.ownerId && !row.owner_id) row.owner_id = m.ownerId;
    row.chunks += 1; row.duration_s += Number(m.durationMs || 0) / 1000;
    if (event.at < row.first_at_ms) row.first_at_ms = event.at;
    if (event.at > row.last_at_ms) row.last_at_ms = event.at;
    if (m.initChunk) row.init_chunks += 1;
    row.total_kb += Math.round((m.byteSize || 0) / 1024);
  }
  const csvRows = [`# session_id: ${manifest.sessionId || ""}`, `# meeting_id: ${manifest.meetingId || ""}`, `# mentor:     ${manifest.mentorLabel || ""}`, `# duration:   ${sessionDurationS}s`, `# generated:  ${new Date().toISOString()}`, "", "stream_id,kind,role,participant_id,owner_id,chunks,duration_s,first_at_s,last_at_s,init_chunks,recorder_restarts,total_kb"];
  for (const row of Array.from(streams.values()).sort((a, b) => a.first_at_ms - b.first_at_ms)) {
    const firstS = sessionStart < Infinity ? ((row.first_at_ms - sessionStart) / 1000).toFixed(1) : "";
    const lastS = sessionStart < Infinity ? ((row.last_at_ms - sessionStart) / 1000).toFixed(1) : "";
    csvRows.push([row.stream_id, row.kind, row.role, row.participant_id || row.stream_id, row.owner_id || "", row.chunks, row.duration_s.toFixed(1), firstS, lastS, row.init_chunks, Math.max(0, row.init_chunks - 1), row.total_kb].join(","));
  }
  return csvRows.join("\n") + "\n";
};

export const appendManifestEvents = (capturesRoot) => async (sessionDir, sessionInfo, savedEvents) => {
  const manifestPath = path.join(sessionDir, "manifest.json");
  const existing = await readManifest(manifestPath);
  const manifest = existing || { formatVersion: 2, ...sessionInfo, startedAt: new Date().toISOString(), updatedAt: null, eventCount: 0, events: [] };
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
  manifest.attendanceCandidates = mergeAttendanceCandidates(manifest.attendanceCandidates || [], sessionInfo.attendanceCandidates || []);
  manifest.captureSummary = buildCaptureSummary(manifest);
  await writeJson(manifestPath, manifest);
  try {
    await writeFile(path.join(sessionDir, "session-breakdown.csv"), buildSessionCsv(manifest), "utf8");
  } catch (e) {
    console.warn("[CSV] Failed to write session-breakdown.csv:", e.message);
  }
  return manifest;
};

export const saveEvent = (capturesRoot) => async (sessionDir, event, index) => {
  const payload = event.payload || {};
  const timestamp = Number(event.at || Date.now());
  const streamId = sanitizeSegment(payload.streamId, "stream");
  const baseName = `${timestamp}-${streamId}-${String(index).padStart(4, "0")}`;
  const saved = { type: event.type, at: timestamp, pageUrl: event.pageUrl, streamId: payload.streamId, targetKey: payload.targetKey, remoteTrackId: payload.remoteTrackId, files: {}, metadata: {} };
  if (payload.participant) saved.participant = payload.participant;

  const chunkIdentityMeta = {
    provisionalParticipantKey: payload.provisionalParticipantKey || null,
    canonicalIdentityType: payload.canonicalIdentityType || null,
    canonicalIdentityValue: payload.canonicalIdentityValue || null,
  };

  if (event.type === "chunk") {
    if (payload.storageKey || payload.s3Key) {
      saved.files.recording = payload.storageKey || payload.s3Key;
      saved.metadata = { streamId: payload.streamId, participantId: payload.participantId, participantStorageKey: payload.participantStorageKey || null, kind: payload.kind, mediaRole: payload.mediaRole, trackSource: payload.trackSource, mimeType: payload.mimeType || "", chunkStartedAt: Number(payload.chunkStartedAt || 0) || null, chunkEndedAt: Number(payload.chunkEndedAt || 0) || null, durationMs: Number(payload.durationMs || 0), initChunk: Boolean(payload.initChunk), index: Number(payload.index || 0), byteSize: Number(payload.byteSize || 0), uploadedDirectly: true, ...chunkIdentityMeta };
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
      saved.metadata = { streamId: payload.streamId, participantId: payload.participantId, participantStorageKey: payload.participantStorageKey || null, kind: payload.kind, mediaRole: payload.mediaRole, trackSource: payload.trackSource, mimeType: payload.mimeType || mimeType, chunkStartedAt: Number(payload.chunkStartedAt || 0) || null, chunkEndedAt: Number(payload.chunkEndedAt || 0) || null, durationMs: Number(payload.durationMs || 0), initChunk: Boolean(payload.initChunk), index: Number(payload.index || 0), byteSize: buffer.byteLength, ...chunkIdentityMeta };
    } else {
      saved.metadata = { streamId: payload.streamId, participantId: payload.participantId, participantStorageKey: payload.participantStorageKey || null, kind: payload.kind, mediaRole: payload.mediaRole, trackSource: payload.trackSource, mimeType: payload.mimeType || "", chunkStartedAt: Number(payload.chunkStartedAt || 0) || null, chunkEndedAt: Number(payload.chunkEndedAt || 0) || null, durationMs: Number(payload.durationMs || 0), initChunk: Boolean(payload.initChunk), index: Number(payload.index || 0), ...chunkIdentityMeta };
    }
    return saved;
  }

  if (event.type === "remote-video-frame") {
    const frameDir = path.join(sessionDir, "frames");
    await mkdir(frameDir, { recursive: true });
    if (payload.thumbnailDataUrl) { const { buffer } = parseDataUrl(payload.thumbnailDataUrl); const p = path.join(frameDir, `${baseName}.jpg`); await writeFile(p, buffer); saved.files.thumbnail = path.relative(sessionDir, p); }
    if (payload.rgbaDataUrl) { const { buffer } = parseDataUrl(payload.rgbaDataUrl); const p = path.join(frameDir, `${baseName}.rgba`); await writeFile(p, buffer); saved.files.rgba = path.relative(sessionDir, p); saved.metadata.rawByteSize = buffer.byteLength; }
    saved.metadata = { ...saved.metadata, width: payload.displayWidth, height: payload.displayHeight, allocationSize: payload.allocationSize, checksum: payload.checksum, trackKind: payload.trackKind, trackSource: payload.trackSource, sourceFormat: payload.sourceFormat, copiedFormat: payload.copiedFormat, rawSource: payload.rawSource, track: payload.track, targetKey: payload.targetKey, remoteTrackId: payload.remoteTrackId };
    return saved;
  }

  if (event.type === "remote-audio-recording" || event.type === "local-audio-recording") {
    const audioDir = path.join(sessionDir, "audio");
    await mkdir(audioDir, { recursive: true });
    const samplesPath = path.join(audioDir, `${baseName}.json`);
    const float32Path = path.join(audioDir, `${baseName}.f32`);
    await writeJson(samplesPath, { sampleRate: payload.sampleRate, channels: payload.channels, sampleCount: payload.sampleCount, samples: payload.samples || [] });
    await writeFile(float32Path, decodeNumberArray(payload.samples, 4));
    saved.files.samples = path.relative(sessionDir, samplesPath);
    saved.files.float32 = path.relative(sessionDir, float32Path);
    saved.metadata = { sampleRate: payload.sampleRate, channels: payload.channels, sampleCount: payload.sampleCount, trackKind: payload.trackKind, trackSource: payload.trackSource, track: payload.track, targetKey: payload.targetKey, remoteTrackId: payload.remoteTrackId };
    return saved;
  }

  if (event.type === "remote-media-recording" || event.type === "local-media-recording") {
    const recordingDir = path.join(sessionDir, "recordings");
    await mkdir(recordingDir, { recursive: true });
    if (payload.dataUrl) { const { buffer, mimeType } = parseDataUrl(payload.dataUrl); const ext = mimeType.includes("webm") ? "webm" : "bin"; const p = path.join(recordingDir, `${baseName}.${ext}`); await writeFile(p, buffer); saved.files.recording = path.relative(sessionDir, p); saved.metadata.byteSize = buffer.byteLength; }
    saved.metadata = { ...saved.metadata, mimeType: payload.mimeType, size: payload.size, durationMs: payload.durationMs, chunkIndex: payload.chunkIndex, hasAudio: payload.hasAudio, hasVideo: payload.hasVideo, trackKind: payload.trackKind, trackSource: payload.trackSource, recordingKind: payload.recordingKind, isPlayableCandidate: payload.isPlayableCandidate, droppedReason: payload.droppedReason, targetKey: payload.targetKey, remoteTrackId: payload.remoteTrackId };
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

export function createApp({ capturesRoot, projectRoot, webhookUrl = "", webhookSecret = "", attendanceIdentityProbe, debugLogPath, lmsSupabase = null } = {}) {
  const counters = { totalBatchRequests: 0, totalEvents: 0, totalBytesReceived: 0, totalSavedFiles: 0, totalErrors: 0, totalS3Uploads: 0, totalS3Errors: 0, totalS3BytesUploaded: 0 };
  const activeSessions = new Map();
  const ACTIVE_SESSION_TTL_MS = 5 * 60 * 1000;
  const serverStartMs = Date.now();
  const identityProbe = attendanceIdentityProbe || createAttendanceIdentityProbe({
    onResult: async ({ sessionId, payload }) => {
      await updateManifestIdentityProbeResult(capturesRoot)({
        meetingId: payload?.candidate?.meetingId,
        sessionId,
        payload,
      });
    },
  });

  let lastCpuUsage = process.cpuUsage();
  let lastCpuMs = Date.now();
  let cpuPercent = 0;
  const cpuTimer = setInterval(() => {
    const now = Date.now();
    const delta = process.cpuUsage(lastCpuUsage);
    const elapsedUs = (now - lastCpuMs) * 1000;
    cpuPercent = Math.min(100, ((delta.user + delta.system) / elapsedUs) * 100);
    lastCpuUsage = process.cpuUsage();
    lastCpuMs = now;
  }, 5000);
  cpuTimer.unref();

  const app = express();
  app.use(morgan("combined"));
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "250mb" }));
  app.use("/captures", express.static(capturesRoot));

  app.get("/health", (_req, res) => res.json({ ok: true, capturesRoot }));

  app.use(createDashboardRouter({
    counters, activeSessions, ACTIVE_SESSION_TTL_MS, serverStartMs,
    getCpuPercent: () => cpuPercent,
    getDiskUsageBytes: () => getDiskUsageBytes(capturesRoot),
  }));

  if (debugLogPath) {
    app.use(createDebugRouter({ debugLogPath }));
  }

  app.use(createCaptureRouter({
    counters, activeSessions, capturesRoot, projectRoot,
    sanitizeSegment, buildCapturePath, buildChunkStorageKey,
    saveEvent: saveEvent(capturesRoot),
    appendManifestEvents: appendManifestEvents(capturesRoot),
    forwardAttendanceCandidates: forwardAttendanceCandidates(webhookUrl, webhookSecret),
    attendanceIdentityProbe: identityProbe,
  }));

  app.use(createSessionsRouter({
    capturesRoot, sanitizeSegment,
    enrichManifest: enrichManifest(capturesRoot),
  }));

  if (lmsSupabase) {
    app.use(createCheckinRouter({ lmsSupabase }));
    app.use(createLinkRouter({ lmsSupabase }));
    app.use(createAutoCheckinRouter({ lmsSupabase }));
  }

  app.use((error, _req, res, _next) => {
    counters.totalErrors += 1;
    console.error(error);
    res.status(500).json({ ok: false, reason: error.message });
  });

  return { app, counters, activeSessions, ACTIVE_SESSION_TTL_MS, serverStartMs, getCpuPercent: () => cpuPercent, getDiskUsageBytes: () => getDiskUsageBytes(capturesRoot) };
}
