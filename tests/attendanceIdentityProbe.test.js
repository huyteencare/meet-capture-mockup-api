import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createAttendanceIdentityProbe, selectBestParticipantMatch } from "../src/attendanceIdentityProbe.js";

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

const makeAttendanceCandidatePayload = (overrides = {}) => ({
  candidateId: "candidate-1",
  participantDisplayName: "Student One",
  joinObservedAt: "2026-05-21T02:00:00.000Z",
  confidence: 0.98,
  matchType: "confident_present",
  evidence: { streamIds: ["stream-1", "stream-2"] },
  ...overrides,
});

const makeAttendanceCandidateEvent = (payload = {}) => ({
  type: "attendance-candidate",
  at: Date.now(),
  payload: makeAttendanceCandidatePayload(payload),
});

let capturesRoot;

before(async () => {
  capturesRoot = await mkdtemp(path.join(os.tmpdir(), "meet-capture-probe-test-"));
});

after(async () => {
  await rm(capturesRoot, { recursive: true, force: true });
});

describe("attendance identity probe integration", () => {
  it("does not run lookup when probe is disabled", async () => {
    let probeCalls = 0;
    const probe = createAttendanceIdentityProbe({
      config: {
        enabled: false,
        credentialsPath: "",
        delegatedAdminEmail: "",
        retryCount: 3,
        retryDelayMs: 0,
        timeMatchWindowMs: 60_000,
      },
      probeRunner: async () => {
        probeCalls += 1;
        return { verdict: "matched_signedin_user", shouldRetry: false };
      },
    });

    const { app } = createApp({
      capturesRoot,
      projectRoot: capturesRoot,
      attendanceIdentityProbe: probe,
    });

    const res = await request(app)
      .post("/api/capture/batch")
      .send({ meetingId: "abc-defg-hij", sessionId: "session-disabled", events: [makeAttendanceCandidateEvent()] });

    await flush();
    assert.equal(res.status, 200);
    assert.equal(probeCalls, 0);
    assert.equal(probe._state.size, 0);
  });

  it("logs missing_credentials and still succeeds when credentials are absent", async () => {
    const logs = [];
    const probe = createAttendanceIdentityProbe({
      logger: {
        log: (line) => logs.push(line),
        warn: (line) => logs.push(line),
      },
      config: {
        enabled: true,
        credentialsPath: "",
        delegatedAdminEmail: "",
        retryCount: 3,
        retryDelayMs: 0,
        timeMatchWindowMs: 60_000,
      },
    });

    const { app } = createApp({
      capturesRoot,
      projectRoot: capturesRoot,
      attendanceIdentityProbe: probe,
    });

    const res = await request(app)
      .post("/api/capture/batch")
      .send({ meetingId: "abc-defg-hij", sessionId: "session-missing-creds", events: [makeAttendanceCandidateEvent()] });

    await flush();
    assert.equal(res.status, 200);
    assert.ok(logs.some((line) => line.includes("\"finalVerdict\":\"missing_credentials\"")));
  });

  it("invokes lookup once per unique meetingId and candidateId across repeated batches", async () => {
    let probeCalls = 0;
    const probe = createAttendanceIdentityProbe({
      config: {
        enabled: true,
        credentialsPath: "/tmp/fake-creds.json",
        delegatedAdminEmail: "admin@example.com",
        retryCount: 1,
        retryDelayMs: 0,
        timeMatchWindowMs: 60_000,
      },
      clientFactory: async () => ({}),
      probeRunner: async () => {
        probeCalls += 1;
        return {
          verdict: "matched_signedin_user",
          conferenceRecord: { name: "conferenceRecords/1", startTime: "2026-05-21T01:59:30.000Z" },
          match: null,
          shouldRetry: false,
        };
      },
    });

    const { app } = createApp({
      capturesRoot,
      projectRoot: capturesRoot,
      attendanceIdentityProbe: probe,
    });

    const payload = { meetingId: "abc-defg-hij", sessionId: "session-dedupe", events: [makeAttendanceCandidateEvent()] };
    await request(app).post("/api/capture/batch").send(payload);
    await request(app).post("/api/capture/batch").send(payload);

    await flush();
    assert.equal(probeCalls, 1);
    assert.equal(probe._state.size, 1);
  });
});

describe("attendance identity probe unit behavior", () => {
  it("prefers a near exact name match over an unrelated overlapping session", () => {
    const candidate = makeAttendanceCandidatePayload({
      participantDisplayName: "Another Account Just",
      joinObservedAt: "2026-05-23T03:29:44.184Z",
    });
    const overlappingHost = {
      name: "conferenceRecords/1/participants/host",
      signedinUser: { displayName: "TeenCare Global", user: "users/host" },
    };
    const namedStudent = {
      name: "conferenceRecords/1/participants/student",
      signedinUser: { displayName: "Another Account Just", user: "users/student" },
    };
    const participantSessionsByParticipantName = new Map([
      [
        overlappingHost.name,
        [{ name: `${overlappingHost.name}/participantSessions/1`, startTime: "2026-05-23T03:27:16.724Z", endTime: null }],
      ],
      [
        namedStudent.name,
        [{ name: `${namedStudent.name}/participantSessions/1`, startTime: "2026-05-23T03:29:44.264Z", endTime: "2026-05-23T03:30:26.975Z" }],
      ],
    ]);

    const { best, scoredCandidates } = selectBestParticipantMatch({
      candidate,
      participants: [overlappingHost, namedStudent],
      participantSessionsByParticipantName,
      timeMatchWindowMs: 600_000,
    });

    assert.equal(scoredCandidates[0]?.participant?.signedinUser?.user, "users/student");
    assert.equal(best?.participant?.signedinUser?.user, "users/student");
  });

  it("retries unresolved probes up to the configured limit", async () => {
    const scheduled = [];
    let probeCalls = 0;
    const probe = createAttendanceIdentityProbe({
      config: {
        enabled: true,
        credentialsPath: "/tmp/fake-creds.json",
        delegatedAdminEmail: "admin@example.com",
        retryCount: 3,
        retryDelayMs: 0,
        timeMatchWindowMs: 60_000,
      },
      clientFactory: async () => ({}),
      setTimeoutFn: (fn) => {
        scheduled.push(fn);
        return { unref() {} };
      },
      probeRunner: async () => {
        probeCalls += 1;
        return {
          verdict: "no_matching_participant_session",
          conferenceRecord: null,
          match: null,
          shouldRetry: true,
        };
      },
    });

    probe.scheduleBatch({
      meetingId: "abc-defg-hij",
      candidates: [makeAttendanceCandidatePayload()],
    });
    await flush();

    while (scheduled.length > 0) {
      const fn = scheduled.shift();
      fn();
      await flush();
    }

    assert.equal(probeCalls, 3);
  });

  it("forwards probe payloads to the onResult callback with session context", async () => {
    const resultCalls = [];
    const probe = createAttendanceIdentityProbe({
      config: {
        enabled: true,
        credentialsPath: "/tmp/fake-creds.json",
        delegatedAdminEmail: "admin@example.com",
        retryCount: 1,
        retryDelayMs: 0,
        timeMatchWindowMs: 600_000,
      },
      clientFactory: async () => ({}),
      onResult: async (result) => {
        resultCalls.push(result);
      },
      probeRunner: async () => ({
        verdict: "matched_signedin_user",
        conferenceRecord: { name: "conferenceRecords/1", startTime: "2026-05-21T01:55:00.000Z" },
        match: {
          participantType: "signedinUser",
          meetDisplayName: "Student One",
          distanceMs: 0,
          overlaps: true,
          participant: { name: "conferenceRecords/1/participants/1", signedinUser: { user: "users/12345" } },
          session: { name: "conferenceRecords/1/participants/1/participantSessions/1", startTime: "2026-05-21T01:59:50.000Z" },
        },
        scoredCandidates: [],
        shouldRetry: false,
      }),
    });

    probe.scheduleBatch({
      meetingId: "abc-defg-hij",
      sessionId: "session-on-result",
      candidates: [makeAttendanceCandidatePayload()],
    });
    await flush();

    assert.equal(resultCalls.length, 1);
    assert.equal(resultCalls[0]?.sessionId, "session-on-result");
    assert.equal(resultCalls[0]?.payload?.finalVerdict, "matched_signedin_user");
    assert.equal(resultCalls[0]?.payload?.identitySignals?.signedinUserUser, "users/12345");
  });

  it("logs signed-in match details from Meet without calling extra enrichment paths", async () => {
    const logs = [];
    const probe = createAttendanceIdentityProbe({
      logger: {
        log: (line) => logs.push(line),
        warn: (line) => logs.push(line),
      },
      config: {
        enabled: true,
        credentialsPath: "/tmp/fake-creds.json",
        delegatedAdminEmail: "admin@example.com",
        retryCount: 1,
        retryDelayMs: 0,
        timeMatchWindowMs: 600_000,
      },
      clientFactory: async () => ({
        meet: {
          conferenceRecords: {
            list: async () => ({
              data: {
                conferenceRecords: [{ name: "conferenceRecords/1", startTime: "2026-05-21T01:55:00.000Z", endTime: "2026-05-21T03:00:00.000Z" }],
              },
            }),
            participants: {
              list: async () => ({
                data: {
                  participants: [{ name: "conferenceRecords/1/participants/1", signedinUser: { displayName: "Student One", user: "users/12345" } }],
                },
              }),
              participantSessions: {
                list: async () => ({
                  data: {
                    participantSessions: [{ name: "conferenceRecords/1/participants/1/participantSessions/1", startTime: "2026-05-21T01:59:50.000Z", endTime: "2026-05-21T02:30:00.000Z" }],
                  },
                }),
              },
            },
          },
        },
      }),
    });

    probe.scheduleBatch({
      meetingId: "abc-defg-hij",
      candidates: [makeAttendanceCandidatePayload()],
    });

    await flush();
    assert.ok(logs.some((line) => line.includes("\"matchOutcome\":\"matched_signedin_user\"")));
    assert.ok(logs.some((line) => line.includes("\"participantType\":\"signedinUser\"")));
    assert.ok(logs.some((line) => line.includes("\"signedinUserUser\":\"users/12345\"")));
    assert.ok(logs.some((line) => line.includes("\"finalVerdict\":\"matched_signedin_user\"")));
  });

  it("logs anonymous_or_phone for anonymous participants without throwing", async () => {
    const logs = [];
    const probe = createAttendanceIdentityProbe({
      logger: {
        log: (line) => logs.push(line),
        warn: (line) => logs.push(line),
      },
      config: {
        enabled: true,
        credentialsPath: "/tmp/fake-creds.json",
        delegatedAdminEmail: "admin@example.com",
        retryCount: 1,
        retryDelayMs: 0,
        timeMatchWindowMs: 600_000,
      },
      clientFactory: async () => ({
        meet: {
          conferenceRecords: {
            list: async () => ({
              data: {
                conferenceRecords: [{ name: "conferenceRecords/1", startTime: "2026-05-21T01:55:00.000Z", endTime: "2026-05-21T03:00:00.000Z" }],
              },
            }),
            participants: {
              list: async () => ({
                data: {
                  participants: [{ name: "conferenceRecords/1/participants/guest-1", anonymousUser: { displayName: "Guest Student" } }],
                },
              }),
              participantSessions: {
                list: async () => ({
                  data: {
                    participantSessions: [{ name: "conferenceRecords/1/participants/guest-1/participantSessions/1", startTime: "2026-05-21T01:59:50.000Z", endTime: "2026-05-21T02:30:00.000Z" }],
                  },
                }),
              },
            },
          },
        },
      }),
    });

    probe.scheduleBatch({
      meetingId: "abc-defg-hij",
      candidates: [makeAttendanceCandidatePayload({ participantDisplayName: "Guest Student" })],
    });

    await flush();
    assert.ok(logs.some((line) => line.includes("\"finalVerdict\":\"anonymous_or_phone\"")));
  });
});
