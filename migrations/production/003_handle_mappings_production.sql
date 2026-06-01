-- Migration 003: extension_handle_mappings — production (ktbzdpbvthnejqjoueln)
-- Maps Google Meet signedinUser.user handle → student/mentor email
-- Safe to re-run

CREATE TABLE IF NOT EXISTS extension_handle_mappings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_handle TEXT NOT NULL UNIQUE,
  student_email TEXT NOT NULL,
  display_name  TEXT,
  linked_by     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE extension_handle_mappings DISABLE ROW LEVEL SECURITY;
