import { generateUploadUrl, isConfigured as isStorageConfigured, uploadFileAndDelete } from "../storage.js";
import { Router } from "express";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export function createCaptureRouter({
  counters,
  activeSessions,
  capturesRoot,
  projectRoot,
  sanitizeSegment,
  buildCapturePath,
  buildChunkStorageKey,
  saveEvent,
  appendManifestEvents,
  forwardAttendanceCandidates,
}) {
  const router = Router();

  router.post("/api/capture/presign", async (req, res, next) => {
    if (!isStorageConfigured()) return res.status(503).json({ ok: false, reason: "Storage not configured" });
    try {
      const body = req.body || {};
      const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
      const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];

      const PRESIGN_CONCURRENCY = 8;
      const results = new Array(chunks.length);
      const queue = chunks.map((chunk, i) => ({ chunk, i }));
      await Promise.all(
        Array.from({ length: Math.min(PRESIGN_CONCURRENCY, queue.length) }, async () => {
          while (queue.length > 0) {
            const { chunk, i } = queue.shift();
            const timestamp = Math.floor(Number(chunk.eventAt || Date.now()));
            const streamId = sanitizeSegment(chunk.streamId || "", "stream");
            const padded = String(Number(chunk.index ?? 0)).padStart(4, "0");
            const baseName = `${timestamp}-${streamId}-${padded}`;
            const storageKey = buildChunkStorageKey(meetingId, sessionId, chunk, baseName);
            const mimeType = String(chunk.mimeType || "video/webm");
            const { uploadUrl } = await generateUploadUrl(storageKey, mimeType, 300);
            results[i] = { storageKey, uploadUrl, expiresAt: Date.now() + 295_000 };
          }
        }),
      );

      res.json({ ok: true, presignedUrls: results });
    } catch (err) {
      next(err);
    }
  });

  router.post("/api/capture/batch", async (req, res, next) => {
    const batchStartMs = Date.now();
    const bytesReceived = Number(req.headers["content-length"] || 0);
    counters.totalBatchRequests += 1;

    try {
      const body = req.body || {};
      const meetingId = sanitizeSegment(body.meetingId, "unknown-meeting");
      const sessionId = sanitizeSegment(body.sessionId, "unknown-session");
      const events = Array.isArray(body.events) ? body.events : [];
      const sessionDir = path.join(capturesRoot, meetingId, sessionId);
      const capturePath = buildCapturePath(meetingId, sessionId);

      await mkdir(sessionDir, { recursive: true });
      activeSessions.set(sessionId, Date.now());

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
          attendanceCandidates: Array.isArray(body.attendanceCandidates) ? body.attendanceCandidates : [],
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

      const forwardedAttendanceCount = await forwardAttendanceCandidates({
        meetingId,
        sessionId,
        mentorLabel: String(body.mentorLabel || "").trim(),
        candidates: events
          .filter((event) => event?.type === "attendance-candidate")
          .map((event) => event?.payload || {}),
      });

      // Fire-and-forget server-side upload for legacy base64 payloads
      if (isStorageConfigured()) {
        const localPaths = savedEvents.flatMap((e) =>
          Object.values(e.files || {})
            .filter((f) => !String(f).startsWith("captures/") && !String(f).endsWith(".json"))
            .map((f) => ({ local: path.join(sessionDir, f), storageKey: `captures/${buildCapturePath(meetingId, sessionId)}/${f}` })),
        );
        const uploadQueue = localPaths.slice();
        const workers = Array.from({ length: Math.min(4, uploadQueue.length) }, async () => {
          while (uploadQueue.length > 0) {
            const item = uploadQueue.shift();
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

      res.json({
        ok: true,
        meetingId,
        sessionId,
        savedEventCount: savedEvents.length,
        totalEventCount: manifest.eventCount,
        attendanceCandidateCount: Array.isArray(manifest.attendanceCandidates)
          ? manifest.attendanceCandidates.length
          : 0,
        forwardedAttendanceCount,
        sessionPath: path.relative(projectRoot, sessionDir),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
