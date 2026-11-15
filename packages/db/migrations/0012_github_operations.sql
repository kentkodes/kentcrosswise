-- 0012 (AR2 slice 2a): GitHub operation records (DESIGN §4.0, §4.2).
-- One row per logical GitHub or planner effect of a task: the planner result, the issue, an agent
-- workflow dispatch, a merge. The orchestrator writes the intent before the effect and the result
-- after it, so a step that is re-run after a crash or a lost response reads the record and
-- reconciles with GitHub instead of repeating the effect. effect_key is task-<id>/<kind>/<n>,
-- computed from checkpointed state; request_hash (sha256 of the normalized request) detects a
-- contradictory request under one key. result holds private plan text: orch_rw only, no other role.
-- Additive, no foreign keys. Grants match exactly the queries in agents/orchestrator/src/graph/store.ts
-- (packages/db/test/github-operations.test.ts runs them as a member of orch_rw).
CREATE TABLE github_operations (
  effect_key text PRIMARY KEY CHECK (length(effect_key) BETWEEN 1 AND 200),
  task_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('plan', 'issue', 'dispatch', 'merge')),
  request_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('intent', 'done')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON github_operations TO orch_rw;
GRANT INSERT (effect_key, task_id, kind, request_hash, state, result, created_at) ON github_operations TO orch_rw;
GRANT UPDATE (state, result, updated_at) ON github_operations TO orch_rw;
