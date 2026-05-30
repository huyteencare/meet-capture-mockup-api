-- Migration 001: Checkin feature — staging (xamikeioudcguwwajbor)
-- Chạy trên staging TRƯỚC khi test extension check-in
-- Safe to re-run (IF NOT EXISTS / IF EXISTS guards)

-- 1. meeting_url column cho KNS sessions
ALTER TABLE kns_class_sessions ADD COLUMN IF NOT EXISTS meeting_url TEXT;

-- 2. source constraint mở rộng để cho phép 'extension'
--    Kiểm tra tên constraint hiện tại nếu cần:
--    SELECT conname FROM pg_constraint WHERE conrelid = 'kns_attendance_manual'::regclass AND contype = 'c';
ALTER TABLE kns_attendance_manual
  DROP CONSTRAINT IF EXISTS kns_attendance_manual_source_check;
ALTER TABLE kns_attendance_manual
  ADD CONSTRAINT kns_attendance_manual_source_check
  CHECK (source IN ('kns_report', 'mentor_manual', 'extension'));
