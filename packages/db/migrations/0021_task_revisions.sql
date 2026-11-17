-- 0021 (AR5b): task revisions, attempts and result evidence (DESIGN §4.0, §4.2).
-- A retry keeps the logical task and records a separate attempt; a replan supersedes the previous
-- contract revision's attempts and QA evidence. task_revisions holds the sanitized public contract of
-- each revision; task_attempts one row per agent dispatch (effect_key = the dispatch key
-- task-<id>/dispatch/<n>), written with the dispatch intent; task_evidence the CI result of a head and
-- the QA review of a head, written when the orchestrator applies them. A docs task has no contract:
-- its attempts and evidence have a NULL revision. Written only by the orchestrator (orch_rw), no other
-- role has any right. Additive, no foreign keys. Grants match exactly the queries in
-- agents/orchestrator/src/graph/store.ts (packages/db/test/task-revisions.test.ts runs them as a
-- member of orch_rw).
CREATE TABLE task_revisions (
  task_id bigint NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  contract_hash text NOT NULL CHECK (contract_hash ~ '^[a-f0-9]{64}$'),
  contract jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  PRIMARY KEY (task_id, revision)
);

CREATE TABLE task_attempts (
  effect_key text PRIMARY KEY CHECK (length(effect_key) BETWEEN 1 AND 200),
  task_id bigint NOT NULL,
  revision integer CHECK (revision IS NULL OR revision >= 1),
  role text NOT NULL CHECK (role IN ('developer', 'qa', 'docs')),
  op integer NOT NULL CHECK (op >= 0),
  contract_hash text CHECK (contract_hash IS NULL OR contract_hash ~ '^[a-f0-9]{64}$'),
  base_sha text CHECK (base_sha IS NULL OR base_sha ~ '^[a-f0-9]{40}$'),
  run_id bigint,
  started_at timestamptz,
  ended_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'superseded', 'lost')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE task_evidence (
  effect_key text PRIMARY KEY CHECK (length(effect_key) BETWEEN 1 AND 200),
  task_id bigint NOT NULL,
  revision integer CHECK (revision IS NULL OR revision >= 1),
  kind text NOT NULL CHECK (kind IN ('ci', 'qa')),
  head_sha text NOT NULL CHECK (length(head_sha) BETWEEN 1 AND 64),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'approved', 'changes_requested')),
  attempt_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  CHECK ((kind = 'ci' AND outcome IN ('success', 'failure')) OR (kind = 'qa' AND outcome IN ('approved', 'changes_requested')))
);

CREATE INDEX task_attempts_task_id_idx ON task_attempts (task_id);
CREATE INDEX task_evidence_task_id_idx ON task_evidence (task_id);

GRANT SELECT, INSERT ON task_revisions, task_attempts, task_evidence TO orch_rw;
GRANT UPDATE (superseded_at) ON task_revisions TO orch_rw;
GRANT UPDATE (superseded_at) ON task_evidence TO orch_rw;
GRANT UPDATE (run_id, started_at, ended_at, outcome) ON task_attempts TO orch_rw;
