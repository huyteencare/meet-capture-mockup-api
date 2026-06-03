import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { createApp } from '../src/app.js';

const DEV_URL = process.env.SUPABASE_LMS_URL;
const DEV_KEY = process.env.SUPABASE_LMS_KEY;
const SERVICE_KEY = process.env.SUPABASE_LMS_SERVICE_KEY;

if (!DEV_URL) {
  console.error('SUPABASE_LMS_URL must be set in .env');
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error('SUPABASE_LMS_SERVICE_KEY must be set in .env (service role key — used only for seeding test data)');
  process.exit(1);
}

// service role client for seeding — bypasses RLS
const db = createClient(DEV_URL, SERVICE_KEY, { realtime: { transport: ws } });
const { app } = createApp({ capturesRoot: '/tmp/test-captures', lmsSupabase: db });

let mentor1on1SessionId;
let duplicateCurrentSessionId;
let duplicateOldSessionId;
let staleSessionId;
let knsSessionId;
let knsNoClassinSessionId;
let knsClassinRowId;
let knsAvailable = false;
const TEST_MEET_CODE = 'tst-chk-001';
const TEST_DUP_MEET_CODE = 'tst-chk-dup-001';
const TEST_STALE_MEET_CODE = 'tst-chk-stale-001';
const TEST_KNS_CODE = 'tst-kns-001';
const TEST_KNS_NO_CLASSIN_CODE = 'tst-kns-no-classin-001';
const TEST_EMAIL = 'test-student@example.com';
const NOW = new Date().toISOString();
const ONE_HOUR_LATER = new Date(Date.now() + 3600_000).toISOString();
const YESTERDAY = new Date(Date.now() - 24 * 3600_000).toISOString();
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600_000).toISOString();
const NINETY_MINUTES_AGO = new Date(Date.now() - 90 * 60_000).toISOString();

before(async () => {
  // Seed mentor 1:1 session
  const { data: s1, error: e1 } = await db
    .from('sessions')
    .insert({
      meeting_url: `https://meet.google.com/${TEST_MEET_CODE}`,
      type: 'mentor_1_1',
      scheduled_start: NOW,
      scheduled_end: ONE_HOUR_LATER,
      status: 'scheduled',
    })
    .select('id')
    .single();
  assert.ok(!e1, `seed sessions: ${e1?.message}`);
  mentor1on1SessionId = s1.id;

  const { data: dupCurrent, error: dupCurrentError } = await db
    .from('sessions')
    .insert({
      meeting_url: `https://meet.google.com/${TEST_DUP_MEET_CODE}`,
      type: 'mentor_1_1',
      scheduled_start: NOW,
      scheduled_end: ONE_HOUR_LATER,
      status: 'scheduled',
    })
    .select('id')
    .single();
  assert.ok(!dupCurrentError, `seed duplicate current session: ${dupCurrentError?.message}`);
  duplicateCurrentSessionId = dupCurrent.id;

  const { data: dupOld, error: dupOldError } = await db
    .from('sessions')
    .insert({
      meeting_url: `https://meet.google.com/${TEST_DUP_MEET_CODE}`,
      type: 'mentor_1_1',
      scheduled_start: TWO_HOURS_AGO,
      scheduled_end: NINETY_MINUTES_AGO,
      status: 'completed',
      updated_at: YESTERDAY,
    })
    .select('id')
    .single();
  assert.ok(!dupOldError, `seed duplicate old session: ${dupOldError?.message}`);
  duplicateOldSessionId = dupOld.id;

  const { data: staleSession, error: staleSessionError } = await db
    .from('sessions')
    .insert({
      meeting_url: `https://meet.google.com/${TEST_STALE_MEET_CODE}`,
      type: 'mentor_1_1',
      scheduled_start: TWO_HOURS_AGO,
      scheduled_end: NINETY_MINUTES_AGO,
      status: 'completed',
      updated_at: YESTERDAY,
    })
    .select('id')
    .single();
  assert.ok(!staleSessionError, `seed stale session: ${staleSessionError?.message}`);
  staleSessionId = staleSession.id;

  // Seed KNS session — skipped if meeting_url column not yet migrated
  const { data: s2, error: e2 } = await db
    .from('kns_class_sessions')
    .insert({
      class_name: 'Test KNS',
      meeting_url: `https://meet.google.com/${TEST_KNS_CODE}`,
      session_date: NOW.slice(0, 10),
      start_at: NOW,
      end_at: NOW,
    })
    .select('id')
    .single();
  if (e2?.message?.includes('meeting_url')) {
    console.log('# KNS tests skipped: meeting_url column not yet on kns_class_sessions (run production migration first)');
  } else {
    assert.ok(!e2, `seed kns_class_sessions: ${e2?.message}`);
    knsSessionId = s2.id;
    knsAvailable = true;

    const { data: classinRow, error: classinError } = await db
      .from('kns_classin')
      .insert({
        class_name: 'Test KNS',
        lesson_name: 'Test KNS - 1',
        start_time: NOW,
        end_time: ONE_HOUR_LATER,
        student_email: TEST_EMAIL,
        student_name: 'Test Student',
        attendance: 'Absence',
      })
      .select('id')
      .single();
    assert.ok(!classinError, `seed kns_classin: ${classinError?.message}`);
    knsClassinRowId = classinRow.id;

    const { data: s3, error: e3 } = await db
      .from('kns_class_sessions')
      .insert({
        class_name: 'Test KNS No Classin',
        meeting_url: `https://meet.google.com/${TEST_KNS_NO_CLASSIN_CODE}`,
        session_date: NOW.slice(0, 10),
        start_at: NOW,
        end_at: NOW,
      })
      .select('id')
      .single();
    assert.ok(!e3, `seed kns_class_sessions no classin: ${e3?.message}`);
    knsNoClassinSessionId = s3.id;
  }
});

after(async () => {
  // Clean up in reverse FK order
  await db.from('meet_attendance').delete().eq('session_id', mentor1on1SessionId);
  await db.from('meet_attendance').delete().in('session_id', [duplicateCurrentSessionId, duplicateOldSessionId]);
  await db.from('meet_attendance').delete().eq('session_id', staleSessionId);
  await db.from('kns_attendance_manual').delete().eq('session_id', knsSessionId);
  await db.from('kns_attendance_manual').delete().eq('session_id', knsNoClassinSessionId);
  if (knsClassinRowId) {
    await db.from('kns_classin').delete().eq('id', knsClassinRowId);
  }
  await db.from('sessions').delete().eq('id', mentor1on1SessionId);
  await db.from('sessions').delete().in('id', [duplicateCurrentSessionId, duplicateOldSessionId]);
  await db.from('sessions').delete().eq('id', staleSessionId);
  await db.from('kns_class_sessions').delete().eq('id', knsSessionId);
  await db.from('kns_class_sessions').delete().eq('id', knsNoClassinSessionId);
});

test('POST /api/checkin — missing fields returns 400', async () => {
  const res = await request(app).post('/api/checkin').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'missing_fields');
});

test('POST /api/checkin — Mentor 1:1 writes meet_attendance', async () => {
  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_MEET_CODE,
    participantEmail: TEST_EMAIL,
    participantType: 'student',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.type, 'mentor_1_1');
  assert.ok(res.body.attendanceId, 'attendanceId should be returned');

  // Verify DB record
  const { data } = await db
    .from('meet_attendance')
    .select('*')
    .eq('session_id', mentor1on1SessionId)
    .eq('participant_email', TEST_EMAIL)
    .single();
  assert.ok(data, 'record should exist in meet_attendance');
  assert.equal(data.participant_type, 'student');
  assert.equal(data.duration_seconds, 0);
  assert.equal(data.meet_log_id, null);

  const { data: session } = await db
    .from('sessions')
    .select('status')
    .eq('id', mentor1on1SessionId)
    .single();
  assert.equal(session.status, 'completed');
});

test('POST /api/checkin — duplicate check-in is idempotent', async () => {
  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_MEET_CODE,
    participantEmail: TEST_EMAIL,
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.type, 'mentor_1_1');

  // Still only 1 record
  const { data } = await db
    .from('meet_attendance')
    .select('id')
    .eq('session_id', mentor1on1SessionId)
    .eq('participant_email', TEST_EMAIL);
  assert.equal(data.length, 1, 'should not create duplicate records');
});

test('POST /api/checkin — duplicate meeting_url chooses current matching session', async () => {
  const duplicateEmail = 'duplicate-meeting@example.com';
  await db.from('meet_attendance').delete().in('session_id', [duplicateCurrentSessionId, duplicateOldSessionId]).eq('participant_email', duplicateEmail);

  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_DUP_MEET_CODE,
    participantEmail: duplicateEmail,
    joinTime: NOW,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.type, 'mentor_1_1');

  const { data: currentAttendance } = await db
    .from('meet_attendance')
    .select('id')
    .eq('session_id', duplicateCurrentSessionId)
    .eq('participant_email', duplicateEmail)
    .maybeSingle();
  assert.ok(currentAttendance, 'should write attendance to the current session');

  const { data: oldAttendance } = await db
    .from('meet_attendance')
    .select('id')
    .eq('session_id', duplicateOldSessionId)
    .eq('participant_email', duplicateEmail);
  assert.equal(oldAttendance.length, 0, 'should not write attendance to the older duplicate session');
});

test('POST /api/checkin — stale completed session with reused meeting_url returns session_not_found', async () => {
  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_STALE_MEET_CODE,
    participantEmail: 'stale-session@example.com',
    joinTime: NOW,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'session_not_found');
});

test('POST /api/checkin — KNS writes kns_attendance_manual', { skip: !knsAvailable }, async () => {
  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_KNS_CODE,
    participantEmail: TEST_EMAIL,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.type, 'kns');
  assert.ok(res.body.attendanceId);

  const { data } = await db
    .from('kns_attendance_manual')
    .select('*')
    .eq('session_id', knsSessionId)
    .eq('student_email', TEST_EMAIL)
    .single();
  assert.ok(data);
  assert.equal(data.attendance, 'Attendance');
  assert.equal(data.source, 'extension');

  const { data: classinRow } = await db
    .from('kns_classin')
    .select('attendance')
    .eq('id', knsClassinRowId)
    .single();
  assert.equal(classinRow.attendance, 'Attendance');
});

test('POST /api/checkin — KNS without raw classin row still succeeds without synthetic insert', { skip: !knsAvailable }, async () => {
  const noClassinEmail = 'no-classin@example.com';
  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_KNS_NO_CLASSIN_CODE,
    participantEmail: noClassinEmail,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.type, 'kns');

  const { data: manual } = await db
    .from('kns_attendance_manual')
    .select('attendance')
    .eq('session_id', knsNoClassinSessionId)
    .eq('student_email', noClassinEmail)
    .single();
  assert.equal(manual.attendance, 'Attendance');

  const { data: classinRows } = await db
    .from('kns_classin')
    .select('id')
    .eq('student_email', noClassinEmail)
    .eq('class_name', 'Test KNS No Classin');
  assert.equal(classinRows.length, 0);
});

test('POST /api/checkin — mentor participant does not fallback to KNS', { skip: !knsAvailable }, async () => {
  const res = await request(app).post('/api/checkin').send({
    meetCode: TEST_KNS_CODE,
    participantEmail: 'mentor@example.com',
    participantType: 'mentor',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'session_not_found');

  const { data: manualRows } = await db
    .from('kns_attendance_manual')
    .select('id')
    .eq('session_id', knsSessionId)
    .eq('student_email', 'mentor@example.com');
  assert.equal(manualRows.length, 0);
});

test('POST /api/checkin — unknown meetCode returns session_not_found', async () => {
  const res = await request(app).post('/api/checkin').send({
    meetCode: 'xxx-yyy-zzz',
    participantEmail: TEST_EMAIL,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'session_not_found');
});

// ── /api/link-student ─────────────────────────────────────────────────────────

const TEST_HANDLE = 'users/test-handle-99999';
const TEST_HANDLE_MENTOR = 'users/test-mentor-handle-99999';

after(async () => {
  await db.from('extension_handle_mappings').delete().in('google_handle', [TEST_HANDLE, TEST_HANDLE_MENTOR]);
});

test('POST /api/link-student — missing fields returns 400', async () => {
  const res = await request(app).post('/api/link-student').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, 'missing_fields');
});

test('POST /api/link-student — saves student handle mapping', async () => {
  const res = await request(app).post('/api/link-student').send({
    googleHandle: TEST_HANDLE,
    studentEmail: TEST_EMAIL,
    displayName: 'Test Student',
    role: 'student',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.ok(res.body.id);

  const { data } = await db
    .from('extension_handle_mappings')
    .select('*')
    .eq('google_handle', TEST_HANDLE)
    .single();
  assert.equal(data.student_email, TEST_EMAIL);
  assert.equal(data.role, 'student');
});

test('POST /api/link-student — saves mentor handle mapping with role=mentor', async () => {
  const res = await request(app).post('/api/link-student').send({
    googleHandle: TEST_HANDLE_MENTOR,
    studentEmail: 'mentor@example.com',
    role: 'mentor',
  });
  assert.equal(res.body.ok, true);

  const { data } = await db
    .from('extension_handle_mappings')
    .select('role')
    .eq('google_handle', TEST_HANDLE_MENTOR)
    .single();
  assert.equal(data.role, 'mentor');
});

test('POST /api/link-student — upsert overwrites existing mapping', async () => {
  await request(app).post('/api/link-student').send({
    googleHandle: TEST_HANDLE,
    studentEmail: 'new-email@example.com',
    role: 'student',
  });
  const { data } = await db
    .from('extension_handle_mappings')
    .select('student_email')
    .eq('google_handle', TEST_HANDLE)
    .single();
  assert.equal(data.student_email, 'new-email@example.com');
  // restore
  await db.from('extension_handle_mappings')
    .update({ student_email: TEST_EMAIL })
    .eq('google_handle', TEST_HANDLE);
});

// ── /api/auto-checkin ─────────────────────────────────────────────────────────

test('POST /api/auto-checkin — missing fields returns 400', async () => {
  const res = await request(app).post('/api/auto-checkin').send({});
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('POST /api/auto-checkin — handle_not_linked when handle unknown', async () => {
  const res = await request(app).post('/api/auto-checkin').send({
    googleHandle: 'users/unknown-handle',
    meetCode: TEST_MEET_CODE,
  });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'handle_not_linked');
});

test('POST /api/auto-checkin — writes meet_attendance for student role', async () => {
  // clean up previous record first
  await db.from('meet_attendance').delete().eq('session_id', mentor1on1SessionId).eq('participant_email', TEST_EMAIL);

  const res = await request(app).post('/api/auto-checkin').send({
    googleHandle: TEST_HANDLE,
    meetCode: TEST_MEET_CODE,
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.type, 'mentor_1_1');

  const { data } = await db
    .from('meet_attendance')
    .select('participant_type')
    .eq('session_id', mentor1on1SessionId)
    .eq('participant_email', TEST_EMAIL)
    .single();
  assert.equal(data.participant_type, 'student');

  const { data: session } = await db
    .from('sessions')
    .select('status')
    .eq('id', mentor1on1SessionId)
    .single();
  assert.equal(session.status, 'completed');
});

test('POST /api/auto-checkin — writes mentor participant_type for mentor role', async () => {
  const MENTOR_EMAIL = 'mentor@example.com';
  await db.from('meet_attendance').delete().eq('session_id', mentor1on1SessionId).eq('participant_email', MENTOR_EMAIL);

  const res = await request(app).post('/api/auto-checkin').send({
    googleHandle: TEST_HANDLE_MENTOR,
    meetCode: TEST_MEET_CODE,
  });
  assert.equal(res.body.ok, true);

  const { data } = await db
    .from('meet_attendance')
    .select('participant_type')
    .eq('session_id', mentor1on1SessionId)
    .eq('participant_email', MENTOR_EMAIL)
    .single();
  assert.equal(data.participant_type, 'mentor');
});

test('POST /api/auto-checkin — mentor role does not fallback to KNS', { skip: !knsAvailable }, async () => {
  const res = await request(app).post('/api/auto-checkin').send({
    googleHandle: TEST_HANDLE_MENTOR,
    meetCode: TEST_KNS_CODE,
  });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'session_not_found');

  const { data } = await db
    .from('kns_attendance_manual')
    .select('id')
    .eq('session_id', knsSessionId)
    .eq('student_email', 'mentor@example.com');
  assert.equal(data.length, 0);
});

test('POST /api/auto-checkin — session_not_found for unknown meetCode', async () => {
  const res = await request(app).post('/api/auto-checkin').send({
    googleHandle: TEST_HANDLE,
    meetCode: 'xxx-yyy-zzz',
  });
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, 'session_not_found');
});
