-- 0005: relay_rw, the webhook relay's own group role (DESIGN §3.4, §11 "Relay DB role").
-- Until now the relay's login user (relay_app) was a member of orch_rw, which can write every
-- agent table. relay_rw grants exactly what agents/webhook-relay/src/store.ts runs, checked on
-- PGlite (packages/db/test/relay-role.test.ts runs the relay's own queries as a member):
--   INSERT INTO inbound_events (delivery_id, source) ... ON CONFLICT (delivery_id) DO NOTHING
--     RETURNING delivery_id                         -- dedupe claim
--   DELETE FROM inbound_events WHERE delivery_id = $1 -- release after a failed enqueue
--   SELECT id FROM tasks WHERE pr_number | github_issue = $1 ORDER BY id DESC LIMIT 1
--   INSERT INTO usage_events (ts, kind, agent, minutes, cost_usd, task_id, dedupe_key)
--     SELECT ..., (SELECT id FROM tasks WHERE id = $4), $5
--     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id -- Actions minutes (0004)
-- Column SELECT is needed for every column read in WHERE, RETURNING or as the ON CONFLICT
-- arbiter. INSERT is per column: received_at and usage_events.id keep their defaults. No
-- sequence is used (inbound_events has a text key, usage_events a uuid default).
-- Like 0001, this creates only a NOLOGIN group role; moving relay_app from orch_rw to relay_rw
-- is an owner step outside the repo (docs/runbooks/prod-db.md §3.3).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_rw') THEN
    CREATE ROLE relay_rw NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO relay_rw;
GRANT INSERT (delivery_id, source), SELECT (delivery_id), DELETE ON inbound_events TO relay_rw;
GRANT SELECT (id, pr_number, github_issue) ON tasks TO relay_rw;
GRANT INSERT (ts, kind, agent, minutes, cost_usd, task_id, dedupe_key), SELECT (id, dedupe_key)
  ON usage_events TO relay_rw;
