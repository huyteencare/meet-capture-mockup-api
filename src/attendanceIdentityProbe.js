import { google } from "googleapis";
import { readFile } from "node:fs/promises";

const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY_MS = 10_000;
const DEFAULT_TIME_MATCH_WINDOW_MS = 10 * 60 * 1000;
const NAME_MATCH_NEAR_THRESHOLD_MS = 5_000;

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/meetings.space.readonly",
];

const PROBE_PREFIX = "[Attendance Identity Probe]";

const toBoolean = (value) => {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const toInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseIsoMs = (value) => {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
};

const clampString = (value, max) => String(value || "").trim().slice(0, max);

export const normalizeProbeCandidate = (meetingId, candidate = {}) => {
  const candidateId = clampString(candidate.candidateId, 240);
  const participantDisplayName = clampString(candidate.participantDisplayName, 255) || "unknown";
  const displayName = clampString(candidate.displayName || candidate.participantDisplayName, 255) || "unknown";
  const provisionalParticipantKey = clampString(candidate.provisionalParticipantKey, 255) || null;
  const displayNameSource = clampString(candidate.displayNameSource, 64) || "unknown";
  const displayNameConfidence = clampString(candidate.displayNameConfidence, 16) || "low";
  const joinObservedAt = clampString(candidate.joinObservedAt, 64);
  if (!meetingId || !candidateId || !joinObservedAt) return null;
  return {
    meetingId: clampString(meetingId, 120),
    candidateId,
    participantDisplayName,
    displayName,
    provisionalParticipantKey,
    displayNameSource,
    displayNameConfidence,
    joinObservedAt,
    streamIds: Array.isArray(candidate.evidence?.streamIds) ? candidate.evidence.streamIds.map((value) => String(value)) : [],
    confidence: Number(candidate.confidence || 0),
    matchType: clampString(candidate.matchType, 64),
  };
};

const isoOrNull = (value) => {
  const ms = parseIsoMs(value);
  return ms === null ? null : new Date(ms).toISOString();
};

const participantTypeOf = (participant = {}) => {
  if (participant.signedinUser?.user) return "signedinUser";
  if (participant.anonymousUser) return "anonymousUser";
  if (participant.phoneUser) return "phoneUser";
  return "unknown";
};

const participantDisplayNameOf = (participant = {}) =>
  participant.signedinUser?.displayName ||
  participant.anonymousUser?.displayName ||
  participant.phoneUser?.displayName ||
  "";

const candidateHasUsableName = (candidate = {}) => {
  const participantDisplayName = String(candidate.participantDisplayName || "").trim();
  if (!participantDisplayName || participantDisplayName === "unknown") return false;
  const confidence = String(candidate.displayNameConfidence || "").trim().toLowerCase();
  return confidence === "high" || confidence === "medium";
};

export const buildProbeConfigFromEnv = (env = process.env) => ({
  enabled: toBoolean(env.GOOGLE_MEET_IDENTITY_PROBE_ENABLED),
  credentialsPath: String(env.GOOGLE_APPLICATION_CREDENTIALS || "").trim(),
  delegatedAdminEmail: String(env.GOOGLE_WORKSPACE_DELEGATED_ADMIN_EMAIL || "").trim(),
  retryCount: toInteger(env.GOOGLE_MEET_IDENTITY_PROBE_RETRY_COUNT, DEFAULT_RETRY_COUNT),
  retryDelayMs: toInteger(env.GOOGLE_MEET_IDENTITY_PROBE_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
  timeMatchWindowMs: toInteger(env.GOOGLE_MEET_IDENTITY_PROBE_TIME_MATCH_WINDOW_MS, DEFAULT_TIME_MATCH_WINDOW_MS),
});

export const selectBestConferenceRecord = (conferenceRecords = [], joinObservedAt, timeMatchWindowMs) => {
  const joinMs = parseIsoMs(joinObservedAt);
  if (joinMs === null || !Array.isArray(conferenceRecords) || conferenceRecords.length === 0) return null;

  let best = null;
  for (const record of conferenceRecords) {
    const startMs = parseIsoMs(record.startTime);
    const endMs = parseIsoMs(record.endTime);
    if (startMs === null) continue;
    const nearestMs = joinMs < startMs ? startMs : endMs !== null && joinMs > endMs ? endMs : joinMs;
    const distanceMs = Math.abs(joinMs - nearestMs);
    const overlaps = joinMs >= startMs && (endMs === null || joinMs <= endMs);
    if (!overlaps && distanceMs > timeMatchWindowMs) continue;
    const score = { overlaps, distanceMs, startMs };
    if (
      !best ||
      Number(score.overlaps) > Number(best.score.overlaps) ||
      score.distanceMs < best.score.distanceMs ||
      (score.distanceMs === best.score.distanceMs && score.startMs > best.score.startMs)
    ) {
      best = { record, score };
    }
  }

  return best?.record || null;
};

const scoreParticipantSession = ({ candidate, participant, session, timeMatchWindowMs }) => {
  const joinMs = parseIsoMs(candidate.joinObservedAt);
  const startMs = parseIsoMs(session.startTime);
  const endMs = parseIsoMs(session.endTime);
  if (joinMs === null || startMs === null) return null;

  let distanceMs = 0;
  let overlaps = false;
  if (joinMs < startMs) {
    distanceMs = startMs - joinMs;
  } else if (endMs !== null && joinMs > endMs) {
    distanceMs = joinMs - endMs;
  } else {
    overlaps = true;
  }
  if (!overlaps && distanceMs > timeMatchWindowMs) return null;

  const meetDisplayName = participantDisplayNameOf(participant);
  const tieBreakNameMatch =
    !!candidate.participantDisplayName &&
    candidate.participantDisplayName !== "unknown" &&
    meetDisplayName.trim().toLowerCase() === candidate.participantDisplayName.trim().toLowerCase();

  return {
    participant,
    session,
    overlaps,
    distanceMs,
    tieBreakNameMatch,
    participantType: participantTypeOf(participant),
    meetDisplayName,
  };
};

const compareScoredCandidates = (a, b) => {
  const aStrongNameMatch = a.tieBreakNameMatch && a.distanceMs <= NAME_MATCH_NEAR_THRESHOLD_MS;
  const bStrongNameMatch = b.tieBreakNameMatch && b.distanceMs <= NAME_MATCH_NEAR_THRESHOLD_MS;

  if (Number(aStrongNameMatch) !== Number(bStrongNameMatch)) {
    return Number(bStrongNameMatch) - Number(aStrongNameMatch);
  }

  if (Number(a.overlaps) !== Number(b.overlaps)) {
    return Number(b.overlaps) - Number(a.overlaps);
  }

  if (a.distanceMs !== b.distanceMs) {
    return a.distanceMs - b.distanceMs;
  }

  if (Number(a.tieBreakNameMatch) !== Number(b.tieBreakNameMatch)) {
    return Number(b.tieBreakNameMatch) - Number(a.tieBreakNameMatch);
  }

  return 0;
};

export const selectBestParticipantMatch = ({ candidate, participants, participantSessionsByParticipantName, timeMatchWindowMs }) => {
  const scoredCandidates = [];

  for (const participant of participants || []) {
    const sessions = participantSessionsByParticipantName.get(String(participant.name || "")) || [];
    for (const session of sessions) {
      const scored = scoreParticipantSession({ candidate, participant, session, timeMatchWindowMs });
      if (!scored) continue;
      scoredCandidates.push(scored);
    }
  }

  scoredCandidates.sort(compareScoredCandidates);

  return { best: scoredCandidates[0] || null, scoredCandidates };
};

const summarizeConferenceRecord = (record) => {
  if (!record) return null;
  return {
    name: record.name || null,
    startTime: isoOrNull(record.startTime),
    endTime: isoOrNull(record.endTime),
    space: record.space || null,
  };
};

const summarizeMatch = (match) => {
  if (!match) return null;
  const participant = match.participant || {};
  const session = match.session || {};
  return {
    participantId: participant.name || null,
    participantSessionId: session.name || null,
    participantType: match.participantType,
    meetDisplayName: match.meetDisplayName || null,
    signedinUserUser: participant.signedinUser?.user || null,
    sessionStartTime: isoOrNull(session.startTime),
    sessionEndTime: isoOrNull(session.endTime),
    sessionDistanceMs: match.distanceMs,
    sessionOverlapsJoinObservedAt: !!match.overlaps,
  };
};

const summarizeScoredCandidate = (entry) => {
  if (!entry) return null;
  const participant = entry.participant || {};
  const session = entry.session || {};
  return {
    participantId: participant.name || null,
    participantType: entry.participantType || participantTypeOf(participant),
    meetDisplayName: entry.meetDisplayName || participantDisplayNameOf(participant) || null,
    signedinUserUser: participant.signedinUser?.user || null,
    participantSessionId: session.name || null,
    sessionStartTime: isoOrNull(session.startTime),
    sessionEndTime: isoOrNull(session.endTime),
    sessionDistanceMs: entry.distanceMs,
    sessionOverlapsJoinObservedAt: !!entry.overlaps,
    tieBreakNameMatch: !!entry.tieBreakNameMatch,
  };
};

const deriveMatchOutcome = (verdict, match) => {
  if (verdict === "ambiguous_participant_session") return "ambiguous_participant_session";
  if (!match) return verdict === "no_matching_participant_session" ? "no_matching_participant_session" : "unmatched";
  if (match.participantType === "signedinUser") return "matched_signedin_user";
  if (match.participantType === "anonymousUser" || match.participantType === "phoneUser") return "matched_anonymous_or_phone";
  return "matched_unknown_type";
};

const makeLogPayload = ({ attempt, maxAttempts, candidate, conferenceRecord, match, scoredCandidates, verdict, retryScheduled, error }) => ({
  attempt,
  maxAttempts,
  candidate: {
    meetingId: candidate.meetingId,
    candidateId: candidate.candidateId,
    participantDisplayName: candidate.participantDisplayName,
    displayName: candidate.displayName,
    provisionalParticipantKey: candidate.provisionalParticipantKey,
    displayNameSource: candidate.displayNameSource,
    displayNameConfidence: candidate.displayNameConfidence,
    joinObservedAt: candidate.joinObservedAt,
    streamIds: candidate.streamIds,
    confidence: candidate.confidence,
    matchType: candidate.matchType,
  },
  selectedConferenceRecord: summarizeConferenceRecord(conferenceRecord),
  matchOutcome: deriveMatchOutcome(verdict, match),
  candidateScoreboard: Array.isArray(scoredCandidates) ? scoredCandidates.slice(0, 10).map(summarizeScoredCandidate) : [],
  matchedParticipant: summarizeMatch(match),
  identitySignals: { signedinUserUser: verdict === "matched_signedin_user" ? match?.participant?.signedinUser?.user || null : null },
  finalVerdict: verdict,
  retryScheduled: !!retryScheduled,
  error: error ? { message: error.message } : null,
});

const shouldFinalizeSignedInMatch = ({ candidate, match, scoredCandidates = [] }) => {
  if (!match || match.participantType !== "signedinUser") {
    return { finalize: false, reason: "not-signedin-match", hasUsableName: false, runnerUpDistanceMs: null };
  }

  const hasUsableName = candidateHasUsableName(candidate);
  const topHasExactNameMatch = !!match.tieBreakNameMatch && match.distanceMs <= NAME_MATCH_NEAR_THRESHOLD_MS;
  const runnerUp = Array.isArray(scoredCandidates) && scoredCandidates.length > 1 ? scoredCandidates[1] : null;
  const runnerUpDistanceMs = runnerUp ? runnerUp.distanceMs : null;

  if (hasUsableName && topHasExactNameMatch) {
    return { finalize: true, reason: "usable-exact-name-match", hasUsableName, runnerUpDistanceMs };
  }

  if (!hasUsableName && Array.isArray(scoredCandidates) && scoredCandidates.length === 1) {
    return { finalize: true, reason: "single-scored-session", hasUsableName, runnerUpDistanceMs };
  }

  return {
    finalize: false,
    reason: hasUsableName ? "usable-name-without-exact-near-match" : "ambiguous-scored-session",
    hasUsableName,
    runnerUpDistanceMs
  };
};

const createLogger = (logger = console) => ({
  log(payload) {
    const rendered = typeof payload === "string" ? payload : JSON.stringify(payload);
    (logger.log || console.log)(`${PROBE_PREFIX} ${rendered}`);
  },
  warn(payload) {
    const rendered = typeof payload === "string" ? payload : JSON.stringify(payload);
    (logger.warn || console.warn)(`${PROBE_PREFIX} ${rendered}`);
  },
});

export const createGoogleApisClientFactory = ({ credentialsPath, delegatedAdminEmail }) => {
  let cachedClients = null;

  return async () => {
    if (cachedClients) return cachedClients;
    const raw = await readFile(credentialsPath, "utf8");
    const credentials = JSON.parse(raw);
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: GOOGLE_SCOPES,
      subject: delegatedAdminEmail,
    });
    await auth.authorize();
    cachedClients = {
      meet: google.meet({ version: "v2", auth }),
    };
    return cachedClients;
  };
};

const listAllPages = async (fetchPage, dataKey) => {
  const items = [];
  let pageToken;
  do {
    const response = await fetchPage(pageToken);
    const data = response?.data || {};
    items.push(...(Array.isArray(data[dataKey]) ? data[dataKey] : []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return items;
};

export const runGoogleIdentityProbeAttempt = async ({ candidate, clients, timeMatchWindowMs }) => {
  const conferenceRecords = await listAllPages(
    (pageToken) => clients.meet.conferenceRecords.list({
      filter: `space.meeting_code = "${candidate.meetingId}"`,
      pageSize: 100,
      pageToken,
    }),
    "conferenceRecords",
  );

  const conferenceRecord = selectBestConferenceRecord(conferenceRecords, candidate.joinObservedAt, timeMatchWindowMs);
  if (!conferenceRecord?.name) {
    return { verdict: "no_matching_participant_session", conferenceRecord: null, match: null, shouldRetry: true };
  }

  const participants = await listAllPages(
    (pageToken) => clients.meet.conferenceRecords.participants.list({
      parent: conferenceRecord.name,
      pageSize: 100,
      pageToken,
    }),
    "participants",
  );

  const participantSessionsByParticipantName = new Map();
  for (const participant of participants) {
    const sessions = await listAllPages(
      (pageToken) => clients.meet.conferenceRecords.participants.participantSessions.list({
        parent: participant.name,
        pageSize: 100,
        pageToken,
      }),
      "participantSessions",
    );
    participantSessionsByParticipantName.set(String(participant.name || ""), sessions);
  }

  const { best: match, scoredCandidates } = selectBestParticipantMatch({
    candidate,
    participants,
    participantSessionsByParticipantName,
    timeMatchWindowMs,
  });

  if (!match) {
    return { verdict: "no_matching_participant_session", conferenceRecord, match: null, scoredCandidates, shouldRetry: true };
  }

  if (match.participantType === "anonymousUser" || match.participantType === "phoneUser") {
    return { verdict: "anonymous_or_phone", conferenceRecord, match, scoredCandidates, shouldRetry: false };
  }

  const finalizeDecision = shouldFinalizeSignedInMatch({ candidate, match, scoredCandidates });
  if (!finalizeDecision.finalize) {
    return {
      verdict: "ambiguous_participant_session",
      conferenceRecord,
      match,
      scoredCandidates,
      shouldRetry: false
    };
  }

  return { verdict: "matched_signedin_user", conferenceRecord, match, scoredCandidates, shouldRetry: false };
};

export const createAttendanceIdentityProbe = ({
  logger = console,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  config = buildProbeConfigFromEnv(process.env),
  clientFactory,
  probeRunner = runGoogleIdentityProbeAttempt,
  onResult,
} = {}) => {
  const probeLogger = createLogger(logger);
  const inFlightByKey = new Map();
  const resolveClients = clientFactory || createGoogleApisClientFactory({
    credentialsPath: config.credentialsPath,
    delegatedAdminEmail: config.delegatedAdminEmail,
  });

  const finalizeState = (state) => {
    state.completed = true;
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = null;
    }
  };

  const runAttempt = async (state) => {
    const { candidate } = state;

    if (!config.enabled) return;

    if (!config.credentialsPath || !config.delegatedAdminEmail) {
      finalizeState(state);
      const payload = makeLogPayload({
        attempt: state.attempt,
        maxAttempts: state.maxAttempts,
        candidate,
        conferenceRecord: null,
        match: null,
        verdict: "missing_credentials",
        retryScheduled: false,
      });
      probeLogger.warn(payload);
      await onResult?.({ sessionId: state.sessionId, payload });
      return;
    }

    try {
      const clients = await resolveClients();
      const result = await probeRunner({
        candidate,
        clients,
        timeMatchWindowMs: state.timeMatchWindowMs,
      });

      const shouldRetry = !!result.shouldRetry && state.attempt < state.maxAttempts;
      const payload = makeLogPayload({
        attempt: state.attempt,
        maxAttempts: state.maxAttempts,
        candidate,
        conferenceRecord: result.conferenceRecord,
        match: result.match,
        scoredCandidates: result.scoredCandidates || [],
        verdict: result.verdict,
        retryScheduled: shouldRetry,
      });
      probeLogger.log(payload);
      await onResult?.({ sessionId: state.sessionId, payload });

      if (shouldRetry) {
        state.attempt += 1;
        state.timer = setTimeoutFn(() => {
          void runAttempt(state);
        }, state.retryDelayMs);
        if (typeof state.timer?.unref === "function") state.timer.unref();
        return;
      }

      finalizeState(state);
    } catch (error) {
      const looksLikeMissingCredentials =
        error?.code === "ENOENT" ||
        /credential|private key|client_email|no such file/i.test(String(error?.message || ""));
      const verdict = looksLikeMissingCredentials ? "missing_credentials" : "api_error";
      const shouldRetry = verdict === "api_error" && state.attempt < state.maxAttempts;

      const payload = makeLogPayload({
        attempt: state.attempt,
        maxAttempts: state.maxAttempts,
        candidate,
        conferenceRecord: null,
        match: null,
        verdict,
        retryScheduled: shouldRetry,
        error,
      });
      probeLogger.warn(payload);
      await onResult?.({ sessionId: state.sessionId, payload });

      if (shouldRetry) {
        state.attempt += 1;
        state.timer = setTimeoutFn(() => {
          void runAttempt(state);
        }, state.retryDelayMs);
        if (typeof state.timer?.unref === "function") state.timer.unref();
        return;
      }

      finalizeState(state);
    }
  };

  return {
    scheduleBatch({ meetingId, sessionId, candidates = [] }) {
      if (!config.enabled) return 0;
      const normalizedCandidates = candidates
        .map((candidate) => normalizeProbeCandidate(meetingId, candidate))
        .filter(Boolean);

      let scheduledCount = 0;
      for (const candidate of normalizedCandidates) {
        const key = `${candidate.meetingId}::${candidate.candidateId}`;
        if (inFlightByKey.has(key)) continue;
        const state = {
          key,
          sessionId: String(sessionId || "").trim(),
          attempt: 1,
          maxAttempts: Math.max(1, config.retryCount || DEFAULT_RETRY_COUNT),
          retryDelayMs: Math.max(0, config.retryDelayMs || DEFAULT_RETRY_DELAY_MS),
          timeMatchWindowMs: Math.max(0, config.timeMatchWindowMs || DEFAULT_TIME_MATCH_WINDOW_MS),
          candidate,
          timer: null,
          completed: false,
        };
        inFlightByKey.set(key, state);
        scheduledCount += 1;
        void runAttempt(state);
      }
      return scheduledCount;
    },
    _state: inFlightByKey,
  };
};
