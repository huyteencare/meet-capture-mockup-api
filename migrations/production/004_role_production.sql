-- Migration 004: add role column to extension_handle_mappings — production (ktbzdpbvthnejqjoueln)
-- Safe to re-run

ALTER TABLE extension_handle_mappings
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student';

ALTER TABLE extension_handle_mappings
  DROP CONSTRAINT IF EXISTS extension_handle_mappings_role_check;

ALTER TABLE extension_handle_mappings
  ADD CONSTRAINT extension_handle_mappings_role_check
  CHECK (role IN ('student', 'mentor'));
