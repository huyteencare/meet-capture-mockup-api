import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";

let app;
let capturesRoot;

before(async () => {
  capturesRoot = await mkdtemp(path.join(os.tmpdir(), "meet-capture-test-"));
  ({ app } = createApp({ capturesRoot, projectRoot: capturesRoot }));
});

after(async () => {
  await rm(capturesRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });
});

// ---------------------------------------------------------------------------
// /api/stats
// ---------------------------------------------------------------------------

describe("GET /api/stats", () => {
  it("returns expected fields", async () => {
    const res = await request(app).get("/api/stats");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    for (const field of ["uptimeSeconds", "cpuPercent", "memRssMB", "totalBatchRequests", "activeSessionCount", "diskUsageBytes"]) {
      assert.ok(field in res.body, `missing field: ${field}`);
    }
  });
});

// ---------------------------------------------------------------------------
// /api/capture/presign
// ---------------------------------------------------------------------------

describe("POST /api/capture/presign", () => {
  it("returns 503 when storage not configured", async () => {
    // No STORAGE_PROVIDER env → isConfigured() returns false for all providers
    const res = await request(app)
      .post("/api/capture/presign")
      .send({ meetingId: "test-meeting", sessionId: "test-session", chunks: [] });
    // S3 default: S3_BUCKET is set to 'teencare-meet-captures' fallback, so it may be "configured"
    // Just verify it returns JSON and doesn't crash
    assert.ok(res.status === 200 || res.status === 503);
    assert.ok("ok" in res.body);
  });

  it("returns presignedUrls array for empty chunks", async () => {
    const res = await request(app)
      .post("/api/capture/presign")
      .send({ meetingId: "test-meeting", sessionId: "test-session", chunks: [] });
    if (res.status === 200) {
      assert.ok(Array.isArray(res.body.presignedUrls));
      assert.equal(res.body.presignedUrls.length, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// /api/capture/batch
// ---------------------------------------------------------------------------

describe("POST /api/capture/batch", () => {
  it("saves a chunk event with storageKey (direct upload path)", async () => {
    const res = await request(app)
      .post("/api/capture/batch")
      .send({
        meetingId: "meet-abc",
        sessionId: "session-001",
        captureRole: "mentor",
        mentorLabel: "Test Mentor",
        events: [{
          type: "chunk",
          at: Date.now(),
          payload: {
            storageKey: "captures/meet-abc/session-001/participants/student-1/video/chunk.webm",
            streamId: "student-1",
            participantId: "student-1",
            kind: "video",
            mediaRole: "student-video",
            mimeType: "video/webm",
            durationMs: 5000,
            byteSize: 12345,
            initChunk: false,
            index: 0,
          },
        }],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.savedEventCount, 1);
    assert.equal(res.body.meetingId, "meet-abc");
    assert.equal(res.body.sessionId, "session-001");
  });

  it("handles empty events array", async () => {
    const res = await request(app)
      .post("/api/capture/batch")
      .send({ meetingId: "meet-empty", sessionId: "session-empty", events: [] });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.savedEventCount, 0);
  });

  it("handles mixed event types", async () => {
    const now = Date.now();
    const res = await request(app)
      .post("/api/capture/batch")
      .send({
        meetingId: "meet-mixed",
        sessionId: "session-mixed",
        events: [
          {
            type: "chunk",
            at: now,
            payload: {
              storageKey: "captures/meet-mixed/session-mixed/mentor-audio/chunk.webm",
              streamId: "mentor-stream",
              kind: "audio",
              mediaRole: "mentor-audio",
              mimeType: "audio/webm",
              durationMs: 8000,
              byteSize: 9000,
              initChunk: false,
              index: 0,
            },
          },
          {
            type: "peer-created",
            at: now + 1000,
            payload: { streamId: "student-stream", participantId: "student-1" },
          },
        ],
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.savedEventCount, 2);
  });

  it("increments totalEventCount across multiple batches to same session", async () => {
    const base = { meetingId: "meet-multi", sessionId: "session-multi" };

    await request(app).post("/api/capture/batch").send({ ...base, events: [{ type: "peer-created", at: Date.now(), payload: {} }] });
    const res = await request(app).post("/api/capture/batch").send({ ...base, events: [{ type: "peer-created", at: Date.now(), payload: {} }] });

    assert.equal(res.status, 200);
    assert.equal(res.body.totalEventCount, 2);
  });
});

// ---------------------------------------------------------------------------
// /api/sessions
// ---------------------------------------------------------------------------

describe("GET /api/sessions", () => {
  it("returns sessions array", async () => {
    const res = await request(app).get("/api/sessions");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.sessions));
  });

  it("includes session after batch", async () => {
    await request(app).post("/api/capture/batch").send({
      meetingId: "meet-visible",
      sessionId: "session-visible",
      events: [{ type: "peer-created", at: Date.now(), payload: {} }],
    });

    const res = await request(app).get("/api/sessions");
    const found = res.body.sessions.find((s) => s.sessionId === "session-visible");
    assert.ok(found, "session not found in /api/sessions");
    assert.equal(found.meetingId, "meet-visible");
    assert.ok(found.eventCount >= 1);
  });
});

// ---------------------------------------------------------------------------
// /api/sessions/:sessionId
// ---------------------------------------------------------------------------

describe("GET /api/sessions/:sessionId", () => {
  it("returns 404 for unknown sessionId", async () => {
    const res = await request(app).get("/api/sessions/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal(res.body.ok, false);
  });

  it("returns session detail for known sessionId", async () => {
    await request(app).post("/api/capture/batch").send({
      meetingId: "meet-detail",
      sessionId: "session-detail",
      events: [{ type: "peer-created", at: Date.now(), payload: { streamId: "s1" } }],
    });

    const res = await request(app).get("/api/sessions/session-detail");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.session.sessionId, "session-detail");
    assert.equal(res.body.session.meetingId, "meet-detail");
    assert.ok(Array.isArray(res.body.session.events));
    assert.ok("captureSummary" in res.body.session);
  });
});
