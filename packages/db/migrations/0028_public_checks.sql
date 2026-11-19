-- 0028: read-back checks on published records (slice PL6, DESIGN §4.6). Owner-critical: changes a web_public view.
--
-- Each snapshot in public_records gains the results of the versioned check list (apps/web/src/server/checks.ts):
-- `checks` is an array of {check, result} made of fixed codes only (no text, ids or values), and `checks_version`
-- is the version of the list it was checked against. Both are written by the web app (web_rw) at publication, from
-- state read back after the steps. A withheld snapshot has no checks.
--
-- v_public_records gains the two columns at its end (CREATE OR REPLACE keeps the existing columns and the web_public
-- grant). web_public still has no right on any table.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public_records
  ADD COLUMN checks jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checks) = 'array'),
  ADD COLUMN checks_version smallint CHECK (checks_version IS NULL OR checks_version >= 1),
  ADD CONSTRAINT public_records_checks_published_check CHECK (state = 'published' OR (checks = '[]'::jsonb AND checks_version IS NULL));

CREATE OR REPLACE VIEW v_public_records AS
  SELECT r.public_id, date_trunc('hour', r.captured_hour) AS captured_hour, r.kind, r.body, r.steps, r.checks, r.checks_version
    FROM public_records r
   WHERE r.state = 'published';
