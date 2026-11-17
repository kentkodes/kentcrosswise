-- 0022 (AR6 slice 2): the reason a task is held back for lack of an execution slot (DESIGN §4.0, §4.2).
-- A task admitted to the WIP ceiling but refused an active worker slot records the role it waits for
-- here ('developer', 'qa', 'docs'); the owner console shows it as "waiting for a worker". Nothing
-- writes the column yet: the orchestrator slice that claims execution slots sets and clears it.
-- Additive and nullable: every existing row and every build live before this migration keeps NULL.
-- No grant change: the table-level grants of 0002 cover the new column. The office projection does
-- not read it, so an update of this column alone writes no office_outbox row (0007).
SET LOCAL lock_timeout = '5s';
ALTER TABLE tasks ADD COLUMN execution_wait text CHECK (execution_wait IN ('developer', 'qa', 'docs'));
