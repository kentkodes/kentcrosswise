-- 0020 (AR4): ordered child work (DESIGN §4.0, §4.2 step 2, §4.3).
-- tasks.prerequisites: the ids of the sibling subtasks (same parent) that must be merged before this
-- subtask starts; empty for every other task. tasks.base_sha: the main revision that contains the
-- merge of the prerequisite that released the subtask (null if GitHub did not return one, or the
-- subtask had no prerequisites).
-- The orchestrator now starts a released child with a durable message: it inserts the child's
-- `task.created` row into orchestrator_outbox in the same transaction as the state change that
-- makes the child eligible (the split, or a prerequisite's merge), and the sweeper's outbox part
-- sends it. orch_rw gets column INSERT for exactly that statement (ON CONFLICT (message_key) uses
-- its existing SELECT of message_key).
-- Additive and compatible with the build that is live before it: the new columns default to an
-- empty list and null, which is what that build's rows mean; orch_rw already holds table-level
-- rights on tasks (0002), which cover new columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE tasks
  ADD COLUMN prerequisites bigint[] NOT NULL DEFAULT '{}',
  ADD COLUMN base_sha text;

GRANT INSERT (message_key, group_id, body) ON orchestrator_outbox TO orch_rw;
