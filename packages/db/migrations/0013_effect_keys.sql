-- 0013 (AR2 slice 3): effect keys for agent events and approvals (DESIGN §3.2, §4.3).
-- The orchestrator writes each event and approval of a step under a key derived from the task, the
-- input being applied and the effect's place in that step, with ON CONFLICT (effect_key) DO NOTHING,
-- so a step that is re-run after a crash (before its checkpoint) or a redelivered report adds no
-- second event, approval or inbox item. Report usage reuses usage_events.dedupe_key (0004).
-- Additive and nullable: rows written before this migration, by the web or by the pipelines keep
-- NULL (NULLs never conflict), so the build that is live before it keeps working.
-- No grant changes: the table-level grants of 0002 cover the new columns (orch_rw needs SELECT on
-- effect_key for ON CONFLICT and the read-back, which it has).
SET LOCAL lock_timeout = '5s';
ALTER TABLE agent_events ADD COLUMN effect_key text;
ALTER TABLE agent_events ADD CONSTRAINT agent_events_effect_key_key UNIQUE (effect_key);
ALTER TABLE approvals ADD COLUMN effect_key text;
ALTER TABLE approvals ADD CONSTRAINT approvals_effect_key_key UNIQUE (effect_key);
