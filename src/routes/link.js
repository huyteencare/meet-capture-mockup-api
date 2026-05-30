import { Router } from 'express';
import { upsertHandleMapping, lookupHandleMapping } from '../supabase-db.js';

export function createLinkRouter({ lmsSupabase }) {
  const router = Router();

  router.post('/api/link-student', async (req, res, next) => {
    try {
      const { googleHandle, studentEmail, displayName, linkedBy, role } = req.body || {};
      if (!googleHandle || !studentEmail)
        return res.status(400).json({ ok: false, error: 'missing_fields' });
      const record = await upsertHandleMapping(lmsSupabase, { googleHandle, studentEmail, displayName, linkedBy, role });
      res.json({ ok: true, id: record.id });
    } catch (err) { next(err); }
  });

  router.get('/api/student-by-handle/:handle', async (req, res, next) => {
    try {
      const mapping = await lookupHandleMapping(lmsSupabase, req.params.handle);
      if (!mapping) return res.json({ found: false });
      res.json({ found: true, studentEmail: mapping.student_email, displayName: mapping.display_name, role: mapping.role });
    } catch (err) { next(err); }
  });

  return router;
}
