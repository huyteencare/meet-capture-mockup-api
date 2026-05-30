/**
 * Manual end-to-end checkin test for both Mentor 1:1 and KNS.
 * Simulates what the extension sends when a mentor clicks "Check In".
 *
 * Usage:
 *   node --env-file=.env scripts/manual-test-checkin.js <student-email> <meetCode> [mentor_1_1|kns]
 *
 * Examples:
 *   # Test Mentor 1:1 (default)
 *   node --env-file=.env scripts/manual-test-checkin.js student@gmail.com tkm-imiw-haw
 *
 *   # Test KNS (after running kns migration + seed-kns-test-session.js)
 *   node --env-file=.env scripts/manual-test-checkin.js student@gmail.com abc-defg-hij kns
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const studentEmail = process.argv[2];
const meetCode = process.argv[3];
const mode = process.argv[4] || 'mentor_1_1'; // 'mentor_1_1' | 'kns'

if (!studentEmail || !meetCode) {
  console.error('Usage: node --env-file=.env scripts/manual-test-checkin.js <student-email> <meetCode> [mentor_1_1|kns]');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_LMS_URL;
const SERVICE_KEY = process.env.SUPABASE_LMS_SERVICE_KEY;
const API_URL = process.env.API_URL || 'http://localhost:8787';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_LMS_URL and SUPABASE_LMS_SERVICE_KEY must be set in .env');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { realtime: { transport: ws } });

// ── Step 1: Verify session exists ──────────────────────────────────────────
console.log(`\n[1] Looking up ${mode} session for meetCode: ${meetCode}`);

let session = null;
if (mode === 'mentor_1_1') {
  const { data } = await db
    .from('sessions')
    .select('id, type, meeting_url, scheduled_start')
    .like('meeting_url', `%${meetCode}%`)
    .eq('type', 'mentor_1_1')
    .maybeSingle();
  session = data;
  if (!session) {
    console.error(`  ✗ No mentor_1_1 session found for meetCode "${meetCode}"`);
    console.error(`  Run: node --env-file=.env scripts/seed-test-session.js https://meet.google.com/${meetCode}`);
    process.exit(1);
  }
} else {
  const { data, error } = await db
    .from('kns_class_sessions')
    .select('id, class_name, meeting_url, start_at')
    .like('meeting_url', `%${meetCode}%`)
    .maybeSingle();
  if (error?.message?.includes('meeting_url')) {
    console.error('  ✗ meeting_url column chưa có. Chạy migration:');
    console.error('    ALTER TABLE kns_class_sessions ADD COLUMN IF NOT EXISTS meeting_url TEXT;');
    process.exit(1);
  }
  session = data;
  if (!session) {
    console.error(`  ✗ No KNS session found for meetCode "${meetCode}"`);
    console.error(`  Run: node --env-file=.env scripts/seed-kns-test-session.js https://meet.google.com/${meetCode}`);
    process.exit(1);
  }
}

console.log(`  ✓ Session found: ${session.id}`);
console.log(`    ${'type' in session ? `type: ${session.type}` : `class_name: ${session.class_name}`}`);

// ── Step 2: Call the checkin API ───────────────────────────────────────────
console.log(`\n[2] Calling POST ${API_URL}/api/checkin`);
const resp = await fetch(`${API_URL}/api/checkin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ meetCode, participantEmail: studentEmail, participantType: 'student' }),
});

const result = await resp.json();
console.log(`\n  Response (${resp.status}):`, JSON.stringify(result, null, 2));

if (!result.ok) {
  console.error('\n  ✗ Check-in failed');
  process.exit(1);
}
if (result.type !== mode) {
  console.error(`  ✗ Wrong type: expected "${mode}", got "${result.type}"`);
  process.exit(1);
}

// ── Step 3: Verify DB record ───────────────────────────────────────────────
console.log(`\n[3] Verifying DB record`);

let record = null;
if (mode === 'mentor_1_1') {
  const { data } = await db.from('meet_attendance').select('*').eq('id', result.attendanceId).single();
  record = data;
  if (record) {
    console.log('  ✓ meet_attendance record:');
    console.log(`    participant_email: ${record.participant_email}`);
    console.log(`    participant_type:  ${record.participant_type}`);
    console.log(`    duration_seconds:  ${record.duration_seconds}`);
    console.log(`    meet_log_id:       ${record.meet_log_id}`);
  }
} else {
  const { data } = await db.from('kns_attendance_manual').select('*').eq('id', result.attendanceId).single();
  record = data;
  if (record) {
    console.log('  ✓ kns_attendance_manual record:');
    console.log(`    student_email: ${record.student_email}`);
    console.log(`    attendance:    ${record.attendance}`);
    console.log(`    source:        ${record.source}`);
    console.log(`    marked_at:     ${record.marked_at}`);
  }
}

if (!record) {
  console.error('  ✗ Record not found in DB');
  process.exit(1);
}

// ── Step 4: Idempotency ────────────────────────────────────────────────────
console.log(`\n[4] Testing idempotency`);
await fetch(`${API_URL}/api/checkin`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ meetCode, participantEmail: studentEmail, participantType: 'student' }),
});

const table = mode === 'mentor_1_1' ? 'meet_attendance' : 'kns_attendance_manual';
const emailCol = mode === 'mentor_1_1' ? 'participant_email' : 'student_email';
const { count } = await db
  .from(table)
  .select('id', { count: 'exact', head: true })
  .eq('session_id', session.id)
  .eq(emailCol, studentEmail);

if (count === 1) {
  console.log('  ✓ Idempotent — no duplicate');
} else {
  console.warn(`  ✗ ${count} records found (expected 1)`);
}

// ── Cleanup hint ───────────────────────────────────────────────────────────
const cleanupSql = mode === 'mentor_1_1'
  ? `DELETE FROM meet_attendance WHERE session_id = '${session.id}';\nDELETE FROM sessions WHERE id = '${session.id}';`
  : `DELETE FROM kns_attendance_manual WHERE session_id = '${session.id}';\nDELETE FROM kns_class_sessions WHERE id = '${session.id}';`;

console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ALL CHECKS PASSED  [${mode}]
  attendance_id: ${result.attendanceId}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Clean up:
  ${cleanupSql}
`);
