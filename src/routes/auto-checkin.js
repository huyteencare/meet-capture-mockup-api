import { Router } from 'express';
import { autoCheckin } from '../supabase-db.js';

export function createAutoCheckinRouter({ lmsSupabase }) {
  const router = Router();

  router.post('/api/auto-checkin', async (req, res, next) => {
    try {
      const { googleHandle, meetCode, joinTime } = req.body || {};
      if (!googleHandle || !meetCode)
        return res.status(400).json({ ok: false, error: 'missing_fields' });
      const result = await autoCheckin(lmsSupabase, { googleHandle, meetCode, joinTime });
      res.json(result);
    } catch (err) { next(err); }
  });

  return router;
}
