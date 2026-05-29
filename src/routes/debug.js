import { Router } from "express";
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_DEBUG_LOG_BYTES = 2 * 1024 * 1024;

const sanitizeLogEntry = (entry = {}) => ({
  at: String(entry.at || new Date().toISOString()).slice(0, 64),
  source: String(entry.source || "unknown").slice(0, 120),
  meetingId: String(entry.meetingId || "").slice(0, 120) || null,
  sessionId: String(entry.sessionId || "").slice(0, 160) || null,
  tabId: Number.isFinite(Number(entry.tabId)) ? Number(entry.tabId) : null,
  event: String(entry.event || "unknown").slice(0, 120),
  candidateId: String(entry.candidateId || "").slice(0, 240) || null,
  provisionalParticipantKey: String(entry.provisionalParticipantKey || "").slice(0, 255) || null,
  participantDisplayName: String(entry.participantDisplayName || "").slice(0, 255) || null,
  canonicalIdentityType: String(entry.canonicalIdentityType || "").slice(0, 64) || null,
  canonicalIdentityValue: String(entry.canonicalIdentityValue || "").slice(0, 240) || null,
  payload: entry.payload && typeof entry.payload === "object" && !Array.isArray(entry.payload) ? entry.payload : {},
});

export function createDebugRouter({ debugLogPath }) {
  const router = Router();

  const ensureReady = async () => {
    await mkdir(path.dirname(debugLogPath), { recursive: true });
  };

  const rotateIfNeeded = async () => {
    try {
      const info = await stat(debugLogPath);
      if (info.size < MAX_DEBUG_LOG_BYTES) return;
      await writeFile(debugLogPath, "", "utf8");
    } catch {
      // no-op
    }
  };

  router.post("/api/debug/identity-log", async (req, res, next) => {
    try {
      await ensureReady();
      await rotateIfNeeded();
      const line = `${JSON.stringify(sanitizeLogEntry(req.body || {}))}\n`;
      await appendFile(debugLogPath, line, "utf8");
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/debug/identity-log/reset", async (_req, res, next) => {
    try {
      await ensureReady();
      await writeFile(debugLogPath, "", "utf8");
      res.json({ ok: true, resetAt: new Date().toISOString(), debugLogPath });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
