-- 0002: agent-system tables, system flags, the public event view and their grants
-- (DESIGN.md §3.2, §3.4, §4.4, §4.5). Roles were created in 0001.
--
-- tasks.id and agent_events.id are bigint identities rather than uuids: the task number is
-- public anyway (branch kcw/task-<id>, thread task-<id>, the view's task_no), and a monotonic
-- event id gives the public feed a simple cursor.

-- ---------------------------------------------------------------- tables
CREATE TABLE tasks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id    bigint REFERENCES tasks (id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('console', 'agent_request', 'schedule', 'github', 'pipeline')),
  owner_text   text NOT NULL,                                -- private: never shown publicly
  public_title text CHECK (length(public_title) BETWEEN 1 AND 60),
  is_private   boolean NOT NULL DEFAULT true,                -- §4.5: console tasks set false explicitly
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN (
                 'queued', 'planning', 'in_progress', 'waiting', 'merged', 'done', 'failed', 'cancelled')),
  waiting_on   text CHECK (waiting_on IN ('dev', 'ci', 'qa', 'owner', 'deploy')),
  thread_id    text UNIQUE,                                  -- LangGraph thread, task-<id>
  agent        text CHECK (agent IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router')),
  github_issue integer,
  pr_number    integer,
  branch       text,
  head_sha     text,
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_parent_idx ON tasks (parent_id);
CREATE INDEX tasks_pr_number_idx ON tasks (pr_number);
CREATE INDEX tasks_branch_idx ON tasks (branch);
CREATE INDEX tasks_active_idx ON tasks (status) WHERE status NOT IN ('done', 'failed', 'cancelled');

-- Event types: §4.4 (defined once in code in @kcw/core/events).
CREATE TABLE agent_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  task_id    bigint REFERENCES tasks (id) ON DELETE CASCADE,
  agent      text NOT NULL CHECK (agent IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router')),
  event_type text NOT NULL CHECK (event_type IN (
               'task_assigned', 'coding', 'pr_opened', 'ci_running', 'tests_failed', 'ci_passed',
               'qa_reviewing', 'changes_requested', 'approved', 'merged', 'deployed', 'waiting_on_owner',
               'failed')),
  detail     jsonb NOT NULL DEFAULT '{}'                     -- private: never shown publicly
);
CREATE INDEX agent_events_ts_idx ON agent_events (ts);
CREATE INDEX agent_events_task_idx ON agent_events (task_id);

CREATE TABLE approvals (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    bigint REFERENCES tasks (id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('critical_pr', 'agent_request', 'seed_list', 'issue_text')),
  reasons    text[] NOT NULL DEFAULT '{}',
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  note       text,
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX approvals_pending_idx ON approvals (created_at) WHERE status = 'pending';

-- cost_usd is computed from model_prices when the row is written (never hardcoded prices).
CREATE TABLE usage_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('model', 'actions_minutes')),
  agent         text NOT NULL CHECK (agent IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router')),
  provider      text,
  model         text,
  input_tokens  integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  minutes       numeric(10, 2) CHECK (minutes >= 0),
  cost_usd      numeric(12, 6) CHECK (cost_usd >= 0),
  task_id       bigint REFERENCES tasks (id) ON DELETE SET NULL,
  CHECK (kind <> 'model' OR (provider IS NOT NULL AND model IS NOT NULL)),
  CHECK (kind <> 'actions_minutes' OR minutes IS NOT NULL)
);
CREATE INDEX usage_events_ts_idx ON usage_events (ts);

CREATE TABLE model_prices (
  provider         text NOT NULL,
  model            text NOT NULL,
  usd_per_mtok_in  numeric(12, 6) NOT NULL CHECK (usd_per_mtok_in >= 0),
  usd_per_mtok_out numeric(12, 6) NOT NULL CHECK (usd_per_mtok_out >= 0),
  effective_from   date NOT NULL,
  PRIMARY KEY (provider, model, effective_from)
);

-- Webhook delivery dedupe (relay, P2-05).
CREATE TABLE inbound_events (
  delivery_id text PRIMARY KEY,
  source      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE system_flags (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Q2: two separate switches, both off.
INSERT INTO system_flags (key, value) VALUES
  ('agents_paused', 'false'),
  ('pipelines_paused', 'false')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------- public view (§3.2, §4.5)
-- The only thing web_public can read. It runs with the view owner's rights, so web_public needs no
-- grant on the tables. Events without a task, private tasks and tasks without a public title all
-- show 'Private task'. Never add owner_text or detail here.
CREATE VIEW v_public_agent_events AS
SELECT
  e.id,
  e.ts,
  e.agent,
  e.event_type,
  e.task_id AS task_no,
  CASE
    WHEN t.is_private IS NOT FALSE OR t.public_title IS NULL THEN 'Private task'
    ELSE t.public_title
  END AS title
FROM agent_events e
LEFT JOIN tasks t ON t.id = e.task_id;

-- ---------------------------------------------------------------- LangGraph schema (§3, §3.4)
-- The checkpointer creates its own tables here; orch_rw owns them.
CREATE SCHEMA IF NOT EXISTS lg;
GRANT USAGE, CREATE ON SCHEMA lg TO orch_rw, migrator;

-- ---------------------------------------------------------------- grants (§3.4)
-- web_rw: all app tables (boss console, inbox, pause switches, usage panel).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tasks, agent_events, approvals, usage_events, model_prices, inbound_events, system_flags
TO web_rw;
GRANT SELECT ON v_public_agent_events TO web_rw;

-- web_public: the view and nothing else.
GRANT SELECT ON v_public_agent_events TO web_public;

-- orch_rw: agent tables (the lg schema above; contact names in 0001).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tasks, agent_events, approvals, usage_events, model_prices, inbound_events, system_flags
TO orch_rw;

-- pipeline_rw: insert tasks and events only.
GRANT INSERT ON tasks, agent_events TO pipeline_rw;
