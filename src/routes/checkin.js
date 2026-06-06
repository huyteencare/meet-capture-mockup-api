import { Router } from 'express';
import {
  lookupMentor1on1Session,
  lookupKnsSession,
  markMentor1on1SessionCompleted,
  syncKnsClassinAttendance,
  upsertMeetAttendance,
  upsertKnsAttendance,
} from '../supabase-db.js';
import { SESSION_TYPE, PARTICIPANT_TYPE } from '../constants.js';

export function createCheckinRouter({ lmsSupabase }) {
  const router = Router();

  router.post('/api/checkin', async (req, res, next) => {
    try {
      const { meetCode, participantEmail, participantType, joinTime } = req.body || {};
      if (!meetCode || !participantEmail) {
        return res.status(400).json({ ok: false, error: 'missing_fields' });
      }

      const now = joinTime || new Date().toISOString();

      const session = await lookupMentor1on1Session(lmsSupabase, meetCode, now);
      if (session) {
        const record = await upsertMeetAttendance(lmsSupabase, {
          sessionId: session.id,
          participantEmail,
          participantType: participantType || PARTICIPANT_TYPE.STUDENT,
          joinTime: now,
        });
        const sessionSync = await markMentor1on1SessionCompleted(lmsSupabase, session);
        console.info('[Checkin] mentor_1_1 matched', {
          meetCode,
          sessionId: session.id,
          participantEmail,
          participantType: participantType || PARTICIPANT_TYPE.STUDENT,
          attendanceId: record.id,
          sessionSync,
        });
        return res.json({ ok: true, type: SESSION_TYPE.MENTOR_1_1, attendanceId: record.id });
      }

      const knsSession = await lookupKnsSession(lmsSupabase, meetCode, now);
      if (knsSession) {
        if ((participantType || PARTICIPANT_TYPE.STUDENT) === PARTICIPANT_TYPE.MENTOR) {
          console.info('[Checkin] mentor kns acknowledged', { meetCode, sessionId: knsSession.id, participantEmail });
          return res.json({ ok: true, type: SESSION_TYPE.KNS });
        }
        const record = await upsertKnsAttendance(lmsSupabase, {
          sessionId: knsSession.id,
          studentEmail: participantEmail,
          markedAt: now,
        });
        const classinSync = await syncKnsClassinAttendance(lmsSupabase, {
          session: knsSession,
          studentEmail: participantEmail,
        });
        if (classinSync.updated) {
          console.info('[Checkin] kns matched and synced', {
            meetCode,
            sessionId: knsSession.id,
            className: knsSession.class_name,
            studentEmail: participantEmail,
            attendanceId: record.id,
            classinSync,
          });
        } else {
          console.warn('[Checkin] kns matched but classin sync missed', {
            meetCode,
            sessionId: knsSession.id,
            className: knsSession.class_name,
            studentEmail: participantEmail,
            attendanceId: record.id,
            classinSync,
          });
        }
        return res.json({ ok: true, type: SESSION_TYPE.KNS, attendanceId: record.id });
      }

      res.json({ ok: false, status: 'session_not_found' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
