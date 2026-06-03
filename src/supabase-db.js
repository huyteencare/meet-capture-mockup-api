import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { SESSION_TYPE, PARTICIPANT_TYPE, ATTENDANCE_SOURCE, KNS_ATTENDANCE_VALUE } from './constants.js';

export function createLmsClient(env) {
  const url = env.SUPABASE_LMS_URL?.trim();
  // Prefer service role key (bypasses RLS for server-side writes/reads)
  const key = (env.SUPABASE_LMS_SERVICE_KEY || env.SUPABASE_LMS_KEY)?.trim();
  if (!url || !key) throw new Error('SUPABASE_LMS_URL and SUPABASE_LMS_SERVICE_KEY (or SUPABASE_LMS_KEY) are required');
  return createClient(url, key, { realtime: { transport: ws } });
}

const COMPLETED_STATUSES = new Set(['completed', 'cancelled', 'canceled']);
const MAX_MEETING_MATCH_DISTANCE_MS = 12 * 60 * 60 * 1000;

function parseTimeMs(value) {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

function chooseBestMeetingMatch(rows, observedAt, label) {
  if (!rows?.length) return null;
  if (rows.length === 1) return rows[0];

  const observedAtMs = parseTimeMs(observedAt) || Date.now();
  const ranked = [...rows].sort((a, b) => {
    const aDeleted = a.deleted_at ? 1 : 0;
    const bDeleted = b.deleted_at ? 1 : 0;
    if (aDeleted !== bDeleted) return aDeleted - bDeleted;

    const aStartMs = parseTimeMs(a.scheduled_start || a.start_at || a.session_date);
    const bStartMs = parseTimeMs(b.scheduled_start || b.start_at || b.session_date);
    const aEndMs = parseTimeMs(a.scheduled_end || a.end_at);
    const bEndMs = parseTimeMs(b.scheduled_end || b.end_at);

    const aActive = Number.isFinite(aStartMs) && Number.isFinite(aEndMs) && observedAtMs >= aStartMs && observedAtMs <= aEndMs;
    const bActive = Number.isFinite(bStartMs) && Number.isFinite(bEndMs) && observedAtMs >= bStartMs && observedAtMs <= bEndMs;
    if (aActive !== bActive) return aActive ? -1 : 1;

    const aCompleted = COMPLETED_STATUSES.has(String(a.status || '').toLowerCase());
    const bCompleted = COMPLETED_STATUSES.has(String(b.status || '').toLowerCase());
    if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;

    const aDistance = Number.isFinite(aStartMs) ? Math.abs(observedAtMs - aStartMs) : Number.POSITIVE_INFINITY;
    const bDistance = Number.isFinite(bStartMs) ? Math.abs(observedAtMs - bStartMs) : Number.POSITIVE_INFINITY;
    if (aDistance !== bDistance) return aDistance - bDistance;

    const aUpdatedMs = parseTimeMs(a.updated_at || a.created_at);
    const bUpdatedMs = parseTimeMs(b.updated_at || b.created_at);
    if (aUpdatedMs !== bUpdatedMs) return bUpdatedMs - aUpdatedMs;

    return String(a.id).localeCompare(String(b.id));
  });

  const chosen = ranked[0];
  console.warn(
    `[Checkin] Multiple ${label} sessions matched meetCode=${meetCodeForLog(rows)}; chose session=${chosen.id}; candidates=${ranked.map((row) => row.id).join(',')}`,
  );
  return chosen;
}

function isViableMeetingMatch(row, observedAt) {
  if (!row || row.deleted_at) return false;

  const observedAtMs = parseTimeMs(observedAt) || Date.now();
  const startMs = parseTimeMs(row.scheduled_start || row.start_at || row.session_date);
  const endMs = parseTimeMs(row.scheduled_end || row.end_at);
  const completed = COMPLETED_STATUSES.has(String(row.status || '').toLowerCase());
  const active = Number.isFinite(startMs) && Number.isFinite(endMs) && observedAtMs >= startMs && observedAtMs <= endMs;
  if (active) return true;
  if (completed) return false;

  const distance = Number.isFinite(startMs) ? Math.abs(observedAtMs - startMs) : Number.POSITIVE_INFINITY;
  return distance <= MAX_MEETING_MATCH_DISTANCE_MS;
}

function meetCodeForLog(rows) {
  const meetingUrl = rows[0]?.meeting_url || '';
  return meetingUrl.split('/').pop() || meetingUrl || 'unknown';
}

export async function lookupMentor1on1Session(supabase, meetCode, observedAt) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id, meeting_url, scheduled_start, scheduled_end, updated_at, created_at, status, deleted_at')
    .like('meeting_url', `%${meetCode}%`)
    .eq('type', SESSION_TYPE.MENTOR_1_1);
  if (error) throw error;
  const chosen = chooseBestMeetingMatch(data, observedAt, 'mentor_1_1');
  if (!isViableMeetingMatch(chosen, observedAt)) return null;
  return chosen;
}

export async function lookupKnsSession(supabase, meetCode, observedAt) {
  const { data, error } = await supabase
    .from('kns_class_sessions')
    .select('id, meeting_url, session_date, start_at, end_at, updated_at, created_at')
    .like('meeting_url', `%${meetCode}%`)
    .limit(20);
  // 42703 = column does not exist (meeting_url not yet migrated) → treat as no match
  if (error?.code === '42703') return null;
  if (error) throw error;
  const chosen = chooseBestMeetingMatch(data, observedAt, 'kns');
  if (!isViableMeetingMatch(chosen, observedAt)) return null;
  return chosen;
}

export async function upsertMeetAttendance(supabase, { sessionId, participantEmail, participantType, joinTime }) {
  const { data: existing } = await supabase
    .from('meet_attendance')
    .select('id')
    .eq('session_id', sessionId)
    .eq('participant_email', participantEmail)
    .is('meet_log_id', null)
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await supabase
    .from('meet_attendance')
    .insert({
      session_id: sessionId,
      participant_email: participantEmail,
      participant_type: participantType || PARTICIPANT_TYPE.STUDENT,
      join_time: joinTime,
      duration_seconds: 0,
      meet_log_id: null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

export async function upsertKnsAttendance(supabase, { sessionId, studentEmail, markedAt }) {
  const { data: existing } = await supabase
    .from('kns_attendance_manual')
    .select('id')
    .eq('session_id', sessionId)
    .eq('student_email', studentEmail)
    .maybeSingle();
  if (existing) return existing;

  const { data, error } = await supabase
    .from('kns_attendance_manual')
    .insert({
      session_id: sessionId,
      student_email: studentEmail,
      attendance: KNS_ATTENDANCE_VALUE,
      source: ATTENDANCE_SOURCE.EXTENSION,
      marked_at: markedAt,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data;
}

export async function upsertHandleMapping(supabase, { googleHandle, studentEmail, displayName, linkedBy, role }) {
  const { data, error } = await supabase
    .from('extension_handle_mappings')
    .upsert(
      { google_handle: googleHandle, student_email: studentEmail, display_name: displayName, linked_by: linkedBy, role: role || 'student', updated_at: new Date().toISOString() },
      { onConflict: 'google_handle' }
    )
    .select('id').single();
  if (error) throw error;
  return data;
}

export async function lookupHandleMapping(supabase, googleHandle) {
  const { data, error } = await supabase
    .from('extension_handle_mappings')
    .select('student_email, display_name, role')
    .eq('google_handle', googleHandle)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateLeaveTime(supabase, { sessionId, participantEmail, leaveTime }) {
  const { error } = await supabase
    .from('meet_attendance')
    .update({ leave_time: leaveTime })
    .eq('session_id', sessionId)
    .eq('participant_email', participantEmail)
    .is('meet_log_id', null);
  if (error) throw error;
}

export async function autoCheckout(supabase, { googleHandle, meetCode, leaveTime }) {
  const mapping = await lookupHandleMapping(supabase, googleHandle);
  if (!mapping) return { ok: false, status: 'handle_not_linked' };

  const participantEmail = mapping.student_email;
  const now = leaveTime || new Date().toISOString();

  const session = await lookupMentor1on1Session(supabase, meetCode, now);
  if (session) {
    await updateLeaveTime(supabase, { sessionId: session.id, participantEmail, leaveTime: now });
    return { ok: true, type: SESSION_TYPE.MENTOR_1_1 };
  }

  const knsSession = await lookupKnsSession(supabase, meetCode, now);
  if (knsSession) {
    return { ok: true, type: SESSION_TYPE.KNS, skipped: true };
  }

  return { ok: false, status: 'session_not_found' };
}

export async function autoCheckin(supabase, { googleHandle, meetCode, joinTime }) {
  const mapping = await lookupHandleMapping(supabase, googleHandle);
  if (!mapping) return { ok: false, status: 'handle_not_linked' };

  const participantEmail = mapping.student_email;
  const now = joinTime || new Date().toISOString();

  const session = await lookupMentor1on1Session(supabase, meetCode, now);
  if (session) {
    const participantType = mapping.role === 'mentor' ? PARTICIPANT_TYPE.MENTOR : PARTICIPANT_TYPE.STUDENT;
    const record = await upsertMeetAttendance(supabase, { sessionId: session.id, participantEmail, participantType, joinTime: now });
    return { ok: true, type: SESSION_TYPE.MENTOR_1_1, attendanceId: record.id };
  }

  const knsSession = await lookupKnsSession(supabase, meetCode, now);
  if (knsSession) {
    const record = await upsertKnsAttendance(supabase, { sessionId: knsSession.id, studentEmail: participantEmail, markedAt: now });
    return { ok: true, type: SESSION_TYPE.KNS, attendanceId: record.id };
  }

  return { ok: false, status: 'session_not_found' };
}
