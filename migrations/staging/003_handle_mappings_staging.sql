-- Migration 003: extension_handle_mappings — staging (xamikeioudcguwwajbor)
-- Maps Google Meet signedinUser.user handle → student email
-- Safe to re-run

CREATE TABLE IF NOT EXISTS extension_handle_mappings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_handle TEXT NOT NULL UNIQUE,   -- signedinUser.user from Google Meet
  student_email TEXT NOT NULL,          -- email used for check-in
  display_name  TEXT,                   -- student display name (optional)
  linked_by     TEXT,                   -- mentor email/label who linked this
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE extension_handle_mappings DISABLE ROW LEVEL SECURITY;
