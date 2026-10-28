-- Run id -> task links of dispatched agent workflow runs (docs/office/RUN-ID-MAPPING-SPEC.md §2).
-- GitHub sends workflow_run.requested before it evaluates run-name, so the relay maps that delivery
-- by run id through this table. A link is not a signed webhook observation: agent_runs stays the
-- only observation table. One-way and additive; no pruning yet.
-- The foreign key takes a SHARE ROW EXCLUSIVE lock on tasks, which blocks concurrent writers to
-- tasks (readers are not blocked). Like 0007, it sets lock_timeout, so the migration fails fast if
-- it cannot get the lock instead of waiting while later writers queue behind its pending request.
-- The runner wraps each file in its own BEGIN, so SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';
CREATE TABLE agent_dispatches (
  run_id bigint PRIMARY KEY CHECK (run_id > 0),
  task_id bigint NOT NULL REFERENCES tasks(id),
  role text NOT NULL CHECK (role IN ('developer','qa','docs','scraper')),
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON agent_dispatches TO orch_rw;
GRANT SELECT (run_id, task_id, role) ON agent_dispatches TO relay_rw;
