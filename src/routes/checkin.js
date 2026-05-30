import { Router } from 'express';
import {
  lookupMentor1on1Session,
  lookupKnsSession,
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

      const session = await lookupMentor1on1Session(lmsSupabase, meetCode);
      if (session) {
        const record = await upsertMeetAttendance(lmsSupabase, {
          sessionId: session.id,
          participantEmail,
          participantType: participantType || PARTICIPANT_TYPE.STUDENT,
          joinTime: now,
        });
        return res.json({ ok: true, type: SESSION_TYPE.MENTOR_1_1, attendanceId: record.id });
      }

      const knsSession = await lookupKnsSession(lmsSupabase, meetCode);
      if (knsSession) {
        const record = await upsertKnsAttendance(lmsSupabase, {
          sessionId: knsSession.id,
          studentEmail: participantEmail,
          markedAt: now,
        });
        return res.json({ ok: true, type: SESSION_TYPE.KNS, attendanceId: record.id });
      }

      res.json({ ok: false, status: 'session_not_found' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
