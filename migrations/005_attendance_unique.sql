-- Migration 005: unique constraint on meet_attendance for extension check-ins
-- Prevents duplicate records when same participant triggers multiple check-ins
-- Partial index: only applies to extension-inserted rows (meet_log_id IS NULL)
-- Safe to re-run

CREATE UNIQUE INDEX IF NOT EXISTS meet_attendance_ext_unique
  ON meet_attendance (session_id, participant_email)
  WHERE meet_log_id IS NULL;

-- Same for kns_attendance_manual
CREATE UNIQUE INDEX IF NOT EXISTS kns_attendance_manual_unique
  ON kns_attendance_manual (session_id, student_email);
