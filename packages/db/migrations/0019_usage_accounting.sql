-- 0019 (AR3): call records in usage_events (DESIGN §3.2, §3.4, §4.3, §11 Q13).
-- Every in-process model call is recorded by the provider adapter under dedupe_key 'call:<uuid>':
-- a row with outcome 'started' before the request is sent, completed after it with the returned
-- model and token counts ('reported'), or left with NULL tokens as 'unknown' (sent, may be billed,
-- no usage came back) or 'rejected' (the provider refused it with a 4xx status, not billed).
-- purpose says what the call was for and subject_kind/subject_id what it belongs to (ids only,
-- never text); task_id stays the task link. purpose and subject_kind are open words so a new
-- purpose (calendar) needs no migration.
-- Additive and compatible with the build that is live before it: the new columns are nullable or
-- default to 'reported' (what every existing row and every row the live build inserts is), and the
-- agent CHECK only gains 'pipeline' (essay categorize and hooks).
-- Grants: web_rw and orch_rw already hold table-level rights on usage_events (0002). pipeline_rw
-- had none; it gets exactly what the call-record SQL (packages/core/src/models/ledger.ts) runs:
-- column INSERT, SELECT of the conflict target and the guard column, UPDATE of the completed
-- columns. It cannot read tokens, costs or other agents' rows.
SET LOCAL lock_timeout = '5s';

ALTER TABLE usage_events
  ADD COLUMN purpose text CONSTRAINT usage_events_purpose_check CHECK (purpose ~ '^[a-z][a-z_]{0,31}$'),
  ADD COLUMN subject_kind text CONSTRAINT usage_events_subject_kind_check CHECK (subject_kind ~ '^[a-z][a-z_]{0,31}$'),
  ADD COLUMN subject_id text CONSTRAINT usage_events_subject_id_check CHECK (subject_id ~ '^[A-Za-z0-9-]{1,64}$'),
  ADD COLUMN outcome text NOT NULL DEFAULT 'reported'
    CONSTRAINT usage_events_outcome_check CHECK (outcome IN ('started', 'reported', 'unknown', 'rejected')),
  ADD CONSTRAINT usage_events_subject_pair_check CHECK ((subject_kind IS NULL) = (subject_id IS NULL));

ALTER TABLE usage_events DROP CONSTRAINT usage_events_agent_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_agent_check
  CHECK (agent IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router', 'pipeline'));

GRANT INSERT (kind, agent, provider, model, input_tokens, output_tokens, task_id, purpose, subject_kind, subject_id, outcome, dedupe_key),
      SELECT (dedupe_key, outcome),
      UPDATE (model, input_tokens, output_tokens, outcome)
  ON usage_events TO pipeline_rw;
