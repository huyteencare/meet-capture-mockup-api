import { generateDownloadUrl, isConfigured as isStorageConfigured } from "../storage.js";
import { Router } from "express";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

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

const readManifest = async (manifestPath) => {
  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return null;
  }
};

const signEventFiles = async (events, capturePath) => {
  if (!isStorageConfigured()) return events;
  return Promise.all(
    events.map(async (event) => {
      const files = event.files || {};
      if (Object.keys(files).length === 0) return event;
      const fileUrls = {};
      await Promise.all(
        Object.entries(files).map(async ([key, relPath]) => {
          const storageKey = String(relPath).startsWith("captures/")
            ? relPath
            : `captures/${capturePath}/${relPath}`;
          try {
            fileUrls[key] = await generateDownloadUrl(storageKey, 3600);
          } catch {
            // file not in storage — viewer falls back to static path
          }
        }),
      );
      return { ...event, fileUrls };
    }),
  );
};

export function createSessionsRouter({ capturesRoot, sanitizeSegment, enrichManifest }) {
  const router = Router();

  router.get("/api/sessions", async (_req, res, next) => {
    try {
      const manifestPaths = await findManifests(capturesRoot);
      const sessions = [];

      for (const manifestPath of manifestPaths) {
        const manifest = await readManifest(manifestPath);
        if (!manifest) continue;
        const stats = await stat(manifestPath);
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

      sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      res.json({ ok: true, sessions });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/sessions/:sessionId", async (req, res, next) => {
    try {
      const manifestPaths = await findManifests(capturesRoot);
      const target = sanitizeSegment(req.params.sessionId, "");

      for (const manifestPath of manifestPaths) {
        const manifest = enrichManifest(await readManifest(manifestPath), manifestPath);
        if (manifest?.sessionId === target) {
          const signedEvents = await signEventFiles(manifest.events || [], manifest.capturePath);
          res.json({ ok: true, session: { ...manifest, events: signedEvents } });
          return;
        }
      }

      res.status(404).json({ ok: false, reason: "Session not found" });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
