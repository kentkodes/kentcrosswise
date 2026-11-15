-- 0014 (AR7 capture recovery, hub derived records). Additive.
-- 1. The routing outcome on the entry: a fixed error code of the last failed attempt (never a provider
--    message or text), how many attempts were made, and when the last one ended. A pending entry with no
--    code and 0 attempts was never attempted (for example saved just before a crash).
-- 2. One derived row per entry and kind: partial unique indexes on entry_id (rows written by the
--    owner or older code may have a NULL entry_id), so a retried route can never create a duplicate.
-- web_rw already holds table-level SELECT/INSERT/UPDATE/DELETE on all of these (0001), so the new
-- columns need no extra grant.
ALTER TABLE entries
  ADD COLUMN route_error text CHECK (route_error IN ('provider_error', 'invalid_label', 'spend_cap')),
  ADD COLUMN route_attempts integer NOT NULL DEFAULT 0 CHECK (route_attempts >= 0),
  ADD COLUMN route_attempted_at timestamptz;

CREATE UNIQUE INDEX crm_notes_entry_id_key ON crm_notes (entry_id) WHERE entry_id IS NOT NULL;
CREATE UNIQUE INDEX diary_entries_entry_id_key ON diary_entries (entry_id) WHERE entry_id IS NOT NULL;
CREATE UNIQUE INDEX todos_entry_id_key ON todos (entry_id) WHERE entry_id IS NOT NULL;
CREATE UNIQUE INDEX ideas_entry_id_key ON ideas (entry_id) WHERE entry_id IS NOT NULL;
