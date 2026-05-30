-- Migration 002: Checkin feature — production (ktbzdpbvthnejqjoueln)
-- Chạy sau khi staging test ổn
-- Safe to re-run (IF NOT EXISTS / IF EXISTS guards)

-- 1. meeting_url column cho KNS sessions
ALTER TABLE kns_class_sessions ADD COLUMN IF NOT EXISTS meeting_url TEXT;

-- 2. Partial unique index cho meet_attendance từ extension
--    (meet_log_id = null khi từ extension, có value khi từ Google Meet API batch)
CREATE UNIQUE INDEX IF NOT EXISTS meet_attendance_session_participant_no_log
  ON meet_attendance (session_id, participant_email)
  WHERE meet_log_id IS NULL;

-- 3. Unique constraint cho kns_attendance_manual
--    Kiểm tra trước khi chạy:
--    SELECT indexname FROM pg_indexes WHERE tablename = 'kns_attendance_manual';
ALTER TABLE kns_attendance_manual
  ADD CONSTRAINT IF NOT EXISTS kns_attendance_manual_session_student_unique
  UNIQUE (session_id, student_email);

-- 4. source constraint mở rộng để cho phép 'extension'
ALTER TABLE kns_attendance_manual
  DROP CONSTRAINT IF EXISTS kns_attendance_manual_source_check;
ALTER TABLE kns_attendance_manual
  ADD CONSTRAINT kns_attendance_manual_source_check
  CHECK (source IN ('kns_report', 'mentor_manual', 'extension'));
