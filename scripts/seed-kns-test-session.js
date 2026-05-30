/**
 * Creates a test KNS session in staging DB with the given Google Meet URL.
 * Run AFTER: ALTER TABLE kns_class_sessions ADD COLUMN IF NOT EXISTS meeting_url TEXT;
 *
 * Usage:
 *   node --env-file=.env scripts/seed-kns-test-session.js https://meet.google.com/xxx-yyy-zzz
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const meetUrl = process.argv[2];
if (!meetUrl || !meetUrl.includes('meet.google.com')) {
  console.error('Usage: node --env-file=.env scripts/seed-kns-test-session.js https://meet.google.com/xxx-yyy-zzz');
  process.exit(1);
}

const url = process.env.SUPABASE_LMS_URL;
const key = process.env.SUPABASE_LMS_SERVICE_KEY;
if (!url || !key) {
  console.error('SUPABASE_LMS_URL and SUPABASE_LMS_SERVICE_KEY must be set in .env');
  process.exit(1);
}

const db = createClient(url, key, { realtime: { transport: ws } });

const now = new Date();
const oneHourLater = new Date(now.getTime() + 3600_000);

const { data, error } = await db
  .from('kns_class_sessions')
  .insert({
    class_name: '[TEST] KNS Session',
    meeting_url: meetUrl,
    session_date: now.toISOString().slice(0, 10),
    start_at: now.toISOString(),
    end_at: oneHourLater.toISOString(),
    source: 'manual',
  })
  .select('id')
  .single();

if (error) {
  if (error.message.includes('meeting_url')) {
    console.error('✗ Column meeting_url chưa tồn tại. Chạy migration trước:');
    console.error('  ALTER TABLE kns_class_sessions ADD COLUMN IF NOT EXISTS meeting_url TEXT;');
  } else {
    console.error('Failed:', error.message);
  }
  process.exit(1);
}

console.log(`KNS session created: ${data.id}`);
console.log(`Meet URL: ${meetUrl}`);
console.log(`\nClean up sau khi test:`);
console.log(`  DELETE FROM kns_attendance_manual WHERE session_id = '${data.id}';`);
console.log(`  DELETE FROM kns_class_sessions WHERE id = '${data.id}';`);
