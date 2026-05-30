/**
 * Seed a complete mentor + student + session fixture on staging for manual check-in testing.
 *
 * Creates:
 *   1. mentors row  (test-mentor-seed@teencare.test)
 *   2. students row (linked to mentor)
 *   3. sessions row (mentor_1_1, with the meeting URL you provide)
 *
 * Usage:
 *   node --env-file=.env scripts/seed-full-checkin-test.js <meetUrl>
 *
 * Examples:
 *   node --env-file=.env scripts/seed-full-checkin-test.js https://meet.google.com/tkm-imiw-haw
 *
 * Cleanup: script prints DELETE SQL at end — run it in Supabase SQL editor when done.
 *
 * NOTE: Requires SUPABASE_LMS_SERVICE_KEY in .env (service role key to bypass RLS).
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const meetUrl = process.argv[2];

if (!meetUrl || !meetUrl.startsWith('https://meet.google.com/')) {
  console.error('Usage: node --env-file=.env scripts/seed-full-checkin-test.js https://meet.google.com/xxx-yyy-zzz');
  process.exit(1);
}

const meetCode = meetUrl.replace('https://meet.google.com/', '').trim();

const SUPABASE_URL = process.env.SUPABASE_LMS_URL?.trim();
const SERVICE_KEY = process.env.SUPABASE_LMS_SERVICE_KEY?.trim();

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('SUPABASE_LMS_URL and SUPABASE_LMS_SERVICE_KEY must be set in .env');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { realtime: { transport: ws } });

const TAG = '[seed-test]';  // sentinel so we can find/delete these rows

// ── 1. Create mentor ─────────────────────────────────────────────────────────
console.log('\n[1] Creating mentor...');

const { data: mentor, error: mentorErr } = await db
  .from('mentors')
  .insert({
    full_name: `${TAG} Test Mentor`,
    email: 'test-mentor-seed@teencare.test',
    status: 'official',
    current_tier: '0-3months',
    currency: 'VND',
    base_salary_full: 0,
    is_leader: false,
  })
  .select('id, full_name, email')
  .single();

if (mentorErr) {
  console.error('  ✗ mentor insert failed:', mentorErr.message);
  process.exit(1);
}
console.log(`  ✓ mentor: ${mentor.id}  (${mentor.full_name})`);

// ── 2. Create student ────────────────────────────────────────────────────────
console.log('\n[2] Creating student...');

const { data: student, error: studentErr } = await db
  .from('students')
  .insert({
    full_name: `${TAG} Test Student`,
    mentor_id: mentor.id,
    code: 'SEED-TEST-001',
    study_status: 'studying',
  })
  .select('id, full_name, code')
  .single();

if (studentErr) {
  // code unique violation → try without code
  if (studentErr.code === '23505') {
    const { data: s2, error: e2 } = await db
      .from('students')
      .insert({ full_name: `${TAG} Test Student`, mentor_id: mentor.id, study_status: 'active' })
      .select('id, full_name, code')
      .single();
    if (e2) { console.error('  ✗ student insert failed:', e2.message); process.exit(1); }
    Object.assign(student ?? {}, s2);
    console.log(`  ✓ student: ${s2.id}  (${s2.full_name})`);
  } else {
    console.error('  ✗ student insert failed:', studentErr.message);
    process.exit(1);
  }
} else {
  console.log(`  ✓ student: ${student.id}  (${student.full_name})`);
}

const studentId = student?.id;

// ── 3. Create session ────────────────────────────────────────────────────────
console.log('\n[3] Creating session...');

const scheduledStart = new Date().toISOString();
const scheduledEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();

const { data: session, error: sessionErr } = await db
  .from('sessions')
  .insert({
    type: 'mentor_1_1',
    status: 'scheduled',
    mentor_id: mentor.id,
    student_id: studentId,
    meeting_url: meetUrl,
    meeting_provider: 'google_meet',
    scheduled_start: scheduledStart,
    scheduled_end: scheduledEnd,
    recurrence_interval: 1,
    native_meeting_enabled: false,
  })
  .select('id, type, meeting_url, scheduled_start')
  .single();

if (sessionErr) {
  console.error('  ✗ session insert failed:', sessionErr.message);
  // Clean up what we created
  await db.from('students').delete().eq('id', studentId);
  await db.from('mentors').delete().eq('id', mentor.id);
  process.exit(1);
}
console.log(`  ✓ session: ${session.id}`);
console.log(`    meeting_url: ${session.meeting_url}`);
console.log(`    scheduled_start: ${session.scheduled_start}`);

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  SEED COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Mentor:
    id:    ${mentor.id}
    name:  ${mentor.full_name}
    email: ${mentor.email}

  Student:
    id:    ${studentId}
    name:  [seed-test] Test Student

  Session:
    id:    ${session.id}
    type:  mentor_1_1
    url:   ${meetUrl}
    code:  ${meetCode}

  ── Manual test command ──────────────────
  node --env-file=.env scripts/manual-test-checkin.js <student-gmail> ${meetCode}

  ── Cleanup SQL ─────────────────────────
  DELETE FROM meet_attendance WHERE session_id = '${session.id}';
  DELETE FROM sessions WHERE id = '${session.id}';
  DELETE FROM students WHERE id = '${studentId}';
  DELETE FROM mentors WHERE id = '${mentor.id}';
`);
