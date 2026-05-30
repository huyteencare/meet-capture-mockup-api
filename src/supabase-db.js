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

export async function lookupMentor1on1Session(supabase, meetCode) {
  const { data, error } = await supabase
    .from('sessions')
    .select('id')
    .like('meeting_url', `%${meetCode}%`)
    .eq('type', SESSION_TYPE.MENTOR_1_1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function lookupKnsSession(supabase, meetCode) {
  const { data, error } = await supabase
    .from('kns_class_sessions')
    .select('id')
    .like('meeting_url', `%${meetCode}%`)
    .maybeSingle();
  // 42703 = column does not exist (meeting_url not yet migrated) → treat as no match
  if (error?.code === '42703') return null;
  if (error) throw error;
  return data;
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

export async function autoCheckin(supabase, { googleHandle, meetCode, joinTime }) {
  const mapping = await lookupHandleMapping(supabase, googleHandle);
  if (!mapping) return { ok: false, status: 'handle_not_linked' };

  const participantEmail = mapping.student_email;
  const now = joinTime || new Date().toISOString();

  const session = await lookupMentor1on1Session(supabase, meetCode);
  if (session) {
    const participantType = mapping.role === 'mentor' ? PARTICIPANT_TYPE.MENTOR : PARTICIPANT_TYPE.STUDENT;
    const record = await upsertMeetAttendance(supabase, { sessionId: session.id, participantEmail, participantType, joinTime: now });
    return { ok: true, type: SESSION_TYPE.MENTOR_1_1, attendanceId: record.id };
  }

  const knsSession = await lookupKnsSession(supabase, meetCode);
  if (knsSession) {
    const record = await upsertKnsAttendance(supabase, { sessionId: knsSession.id, studentEmail: participantEmail, markedAt: now });
    return { ok: true, type: SESSION_TYPE.KNS, attendanceId: record.id };
  }

  return { ok: false, status: 'session_not_found' };
}
