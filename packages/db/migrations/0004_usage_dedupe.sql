-- 0004: dedupe key for usage_events (P2-15, DESIGN §3.2).
-- The webhook relay records each completed GitHub Actions run attempt as one
-- usage_events(kind 'actions_minutes') row with dedupe_key 'github:workflow_run:<run id>:<attempt>'
-- and inserts with ON CONFLICT (dedupe_key) DO NOTHING, so a redelivered webhook (or a second
-- delivery of the same run) is not counted twice. Rows written without a key (model usage,
-- kcw-report) keep NULL: NULLs never conflict.
-- No grant changes: the existing table-level grants on usage_events cover the new column.
ALTER TABLE usage_events ADD COLUMN dedupe_key text;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_dedupe_key_key UNIQUE (dedupe_key);
