#!/usr/bin/env node
// Usage:
//   node scripts/session-report.js [server-url] [sessionId]
//   node scripts/session-report.js http://18.142.106.202                          ← latest session
//   node scripts/session-report.js http://18.142.106.202 session-2026-05-13T...  ← specific

const API_BASE  = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const TARGET_ID = process.argv[3] || null;

const fetch_json = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
};

const fmt_ms = (ms) => {
  const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
};

// ── resolve session ───────────────────────────────────────────────────────────

let sessionId = TARGET_ID;

if (!sessionId) {
  const list = await fetch_json(`${API_BASE}/api/sessions`);
  const pick = (list.sessions || []).find((s) => s.eventCount > 1);
  if (!pick) { console.error("No sessions found."); process.exit(1); }
  sessionId = pick.sessionId;
  console.log(`No sessionId given — using latest: ${sessionId}\n`);
}

const data = await fetch_json(`${API_BASE}/api/sessions/${sessionId}`);
if (!data.ok) { console.error("Session not found:", sessionId); process.exit(1); }
const sess = data.session;

// ── derive stats from raw events ──────────────────────────────────────────────

const allEvents = sess.events || [];
const chunks    = allEvents.filter((e) => e.type === "chunk");

const timestamps   = allEvents.map((e) => Number(e.at || 0)).filter(Boolean);
const sessionStart = timestamps.length ? Math.min(...timestamps) : 0;
const sessionEnd   = timestamps.length ? Math.max(...timestamps) : 0;
const sessionDurMs = sessionEnd - sessionStart;

// per-role aggregate
const roleStats = {};
for (const e of chunks) {
  const role = e.metadata?.mediaRole || "unknown";
  if (!roleStats[role]) roleStats[role] = { chunks: 0, durationMs: 0, streamIds: new Set(), bytes: 0 };
  roleStats[role].chunks     += 1;
  roleStats[role].durationMs += Number(e.metadata?.durationMs || 0);
  roleStats[role].bytes      += Number(e.metadata?.byteSize   || 0);
  if (e.metadata?.streamId) roleStats[role].streamIds.add(e.metadata.streamId);
}

// non-chunk event type counts
const eventTypeCounts = {};
for (const e of allEvents) {
  if (e.type !== "chunk") eventTypeCounts[e.type] = (eventTypeCounts[e.type] || 0) + 1;
}

// ── student verdicts ──────────────────────────────────────────────────────────

const students = sess.captureSummary?.studentVideoParticipants || [];

const studentRows = students.map((p) => {
  const presenceMs = (p.leaveObservedAt && p.joinObservedAt)
    ? p.leaveObservedAt - p.joinObservedAt : 0;
  const coverage   = presenceMs > 0 ? Math.round((p.actualVideoDurationMs / presenceMs) * 100) : 0;
  const streams    = (p.streamIds || []).length;
  const restarts   = Math.max(0, streams - 1);

  let verdict;
  if (presenceMs < 30_000)  verdict = "SHORT";
  else if (coverage >= 70)  verdict = restarts <= 1 ? "PASS" : "PASS*";
  else if (coverage >= 40)  verdict = "BORDERLINE";
  else                      verdict = "FAIL";

  return {
    name:          (p.participantName || p.ownerId || "?").slice(0, 16),
    joinLabel:     p.joinObservedAt  ? fmt_ms(p.joinObservedAt  - sessionStart) : "—",
    leaveLabel:    p.leaveObservedAt ? fmt_ms(p.leaveObservedAt - sessionStart) : "—",
    presenceLabel: fmt_ms(presenceMs),
    actualLabel:   p.actualVideoDurationLabel || fmt_ms(p.actualVideoDurationMs),
    coverage,
    chunks:        p.videoChunkCount,
    streams,
    restarts,
    verdict,
  };
});

// ── checklist ─────────────────────────────────────────────────────────────────

const r_mentor  = roleStats["mentor-audio"]  || { chunks: 0 };
const r_shared  = roleStats["shared-audio"]  || { chunks: 0 };
const r_student = roleStats["student-video"] || { chunks: 0 };

const checks = [
  ["mentor-audio present",     r_mentor.chunks  > 0],
  ["shared-audio present",     r_shared.chunks  > 0],
  ["student-video present",    r_student.chunks > 0],
  ["no ghost participants",    students.every((p) => p.videoChunkCount > 0)],
  ["actualVideo not frozen",   studentRows.every((r) => r.verdict !== "FAIL")],
];

const allPass      = checks.every(([, ok]) => ok);
const criticalFail = !checks[0][1] || !checks[2][1];
const overallVerdict = criticalFail ? "FAIL" : allPass ? "PASS" : "BORDERLINE";

// ── render helpers ────────────────────────────────────────────────────────────

const W   = 62;
const TOP = `╔${"═".repeat(W)}╗`;
const BOT = `╚${"═".repeat(W)}╝`;
const HR  = (ch = "═") => `╠${ch.repeat(W)}╣`;
const pad = (s, n) => String(s ?? "").padEnd(n);
const rpad = (s, n) => String(s ?? "").padStart(n);

const cell = (label, value) => {
  const line = `  ${pad(label, 24)}${value}`;
  return `║${line.padEnd(W)}║`;
};
const cap = (t) => `║  ${String(t).padEnd(W - 2)}║`;

const C = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[90m", reset: "\x1b[0m" };
const color = { PASS: C.green, "PASS*": C.green, BORDERLINE: C.yellow, FAIL: C.red, SHORT: C.dim };
const colored = (v) => `${color[v] || ""}${v}${C.reset}`;

const tick = (ok) => ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;

// ── print ─────────────────────────────────────────────────────────────────────

console.log(`\n${TOP}`);
console.log(cap("── Session Report"));
console.log(HR());
console.log(cell("Session:", sessionId.replace("session-", "").slice(0, 38)));
console.log(cell("Mentor:", sess.mentorLabel || "—"));
console.log(cell("Meeting:", sess.meetingId  || "—"));
console.log(cell("Duration:", `${fmt_ms(sessionDurMs)}  (${(sessionDurMs / 60000).toFixed(1)} min)`));
console.log(cell("Total events:", `${sess.eventCount}  (${chunks.length} chunks)`));
console.log(cell("Started:", sess.startedAt ? sess.startedAt.replace("T", " ").slice(0, 19) : "—"));

// non-chunk events summary
const ncLine = Object.entries(eventTypeCounts).map(([k, v]) => `${k}:${v}`).join("  ");
if (ncLine) console.log(cell("Other events:", ncLine.slice(0, W - 28)));

// ── stream health ─────────────────────────────────────────────────────────────

console.log(HR());
console.log(cap("── Stream Health"));
console.log(HR("-"));
console.log(cap(`  ${"role".padEnd(18)} ${"chunks".padStart(6)}  ${"duration".padStart(8)}  ${"size".padStart(7)}  streams`));
console.log(HR("-"));

const ROLE_ORDER = ["mentor-audio", "shared-audio", "student-video"];
for (const role of ROLE_ORDER) {
  const r = roleStats[role];
  if (!r) {
    console.log(cap(`  ${tick(false)}  ${pad(role, 16)} —`));
  } else {
    const sizeMB = (r.bytes / 1048576).toFixed(1);
    console.log(cap(
      `  ${tick(r.chunks > 0)}  ${pad(role, 16)} ` +
      `${rpad(r.chunks, 6)}  ${rpad(fmt_ms(r.durationMs), 8)}  ${rpad(sizeMB + " MB", 7)}  ${r.streamIds.size}`
    ));
  }
}
for (const [role, r] of Object.entries(roleStats)) {
  if (!ROLE_ORDER.includes(role)) {
    console.log(cap(`  ?  ${pad(role, 16)} ${r.chunks} chunks`));
  }
}

// ── student mapping table ─────────────────────────────────────────────────────

if (studentRows.length > 0) {
  console.log(HR());
  console.log(cap("── Student Mapping Stability"));
  console.log(HR("-"));
  console.log(cap(`  ${"name".padEnd(17)} ${"join".padStart(5)}  ${"leave".padStart(5)}  ${"presence".padStart(8)}  ${"actual".padStart(6)}  ${"cov".padStart(4)}  ${"chnk".padStart(4)}  str  verdict`));
  console.log(HR("-"));

  for (const r of studentRows) {
    const vStr = r.restarts > 0 && r.verdict.startsWith("PASS")
      ? `${r.verdict}(${r.restarts}r)` : r.verdict;
    const base =
      `  ${pad(r.name, 17)} ` +
      `${rpad(r.joinLabel, 5)}  ${rpad(r.leaveLabel, 5)}  ` +
      `${rpad(r.presenceLabel, 8)}  ${rpad(r.actualLabel, 6)}  ` +
      `${rpad(r.coverage + "%", 4)}  ${rpad(r.chunks, 4)}  ${rpad(r.streams, 2)}   `;
    // colored verdict appended — extra chars from escape codes need manual padding
    const raw = `║  ${base}${vStr}`;
    const coloredVerdict = colored(vStr);
    console.log(`║  ${base}${coloredVerdict}${" ".repeat(Math.max(0, W - raw.length))}║`);
  }
}

// ── checklist ─────────────────────────────────────────────────────────────────

console.log(HR());
console.log(cap("── Pass/Fail Checklist"));
console.log(HR("-"));
for (const [label, ok] of checks) {
  console.log(cap(`  [${tick(ok)}] ${label}`));
}

// ── overall verdict ───────────────────────────────────────────────────────────

console.log(HR());
console.log(cap("── Overall Verdict"));
console.log(HR("-"));
const vRaw = `║  ${overallVerdict}`;
console.log(`║  ${colored(overallVerdict)}${" ".repeat(Math.max(0, W - vRaw.length + 1))}║`);

if (overallVerdict !== "PASS") {
  const failedChecks = checks.filter(([, ok]) => !ok).map(([l]) => l);
  if (failedChecks.length) console.log(cap(`  Issues: ${failedChecks.join(", ")}`));
  for (const r of studentRows.filter((r) => r.verdict === "FAIL" || r.verdict === "BORDERLINE")) {
    console.log(cap(`  ${r.name}: ${r.coverage}% video coverage (${r.actualLabel} / ${r.presenceLabel})`));
  }
}
console.log(BOT);
console.log(`\n  PASS* = pass with recorder restarts (multiple stream IDs)\n`);
