/**
 * Creates a test mentor_1_1 session in staging DB with the given Google Meet URL.
 *
 * Usage:
 *   node --env-file=.env scripts/seed-test-session.js https://meet.google.com/xxx-yyy-zzz
 *
 * Prints the session ID — save it to clean up later via Supabase dashboard.
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const meetUrl = process.argv[2];
if (!meetUrl || !meetUrl.includes('meet.google.com')) {
  console.error('Usage: node --env-file=.env scripts/seed-test-session.js https://meet.google.com/xxx-yyy-zzz');
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
  .from('sessions')
  .insert({
    meeting_url: meetUrl,
    type: 'mentor_1_1',
    scheduled_start: now.toISOString(),
    scheduled_end: oneHourLater.toISOString(),
  })
  .select('id')
  .single();

if (error) {
  console.error('Failed:', error.message);
  process.exit(1);
}

console.log(`Session created: ${data.id}`);
console.log(`Meet URL: ${meetUrl}`);
console.log(`\nNow:`);
console.log(`  1. Join the meet as mentor`);
console.log(`  2. Extension sẽ detect student — link email trong popup`);
console.log(`  3. Click Check In`);
console.log(`  4. Verify: SELECT * FROM meet_attendance WHERE session_id = '${data.id}'`);
console.log(`\nClean up sau khi test:`);
console.log(`  DELETE FROM meet_attendance WHERE session_id = '${data.id}';`);
console.log(`  DELETE FROM sessions WHERE id = '${data.id}';`);
