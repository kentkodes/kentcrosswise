-- 0025 (public log slice PL2, DESIGN §4.6): router step rows in agent_events. Each step of a capture writes
-- one agent_events row with agent 'router', keyed to its entry by the new entry_id column (ON DELETE CASCADE:
-- deleting an entry deletes its steps). detail stays private and holds fixed codes and ids only, never entry
-- text; the sanitized public copy is written at publication (PL4), not here.
-- Router step types are separate from the development event types and only router rows may use them; router
-- rows carry an entry and never a task. Existing rows are not re-checked (NOT VALID): no code wrote router rows
-- before this migration (the orchestrator writes development agents only), and every existing row has entry_id NULL.
-- Router steps are not development activity: v_public_agent_events (the public feed of the home page and
-- /office) leaves them out, and office_enqueue no longer queues them for the office projection (which
-- rejected them as invalid_task, as they have no task). No grant change: web_rw already inserts agent_events.
SET LOCAL lock_timeout = '5s';

ALTER TABLE agent_events ADD COLUMN entry_id uuid REFERENCES entries (id) ON DELETE CASCADE;
CREATE INDEX agent_events_entry_idx ON agent_events (entry_id, id) WHERE entry_id IS NOT NULL;

ALTER TABLE agent_events DROP CONSTRAINT agent_events_event_type_check;
ALTER TABLE agent_events ADD CONSTRAINT agent_events_event_type_check CHECK (event_type IN (
  -- development (0002)
  'task_assigned', 'coding', 'pr_opened', 'ci_running', 'tests_failed', 'ci_passed',
  'qa_reviewing', 'changes_requested', 'approved', 'merged', 'deployed', 'waiting_on_owner',
  'failed',
  -- router steps, written automatically (PL2)
  'captured', 'routed', 'needs_owner', 'route_failed', 'derived', 'contact_linked', 'mood_scored',
  'calendar_suggested', 'corrected',
  -- router steps, the owner's verdicts (PL3)
  'confirmed', 'contact_chosen', 'calendar_added', 'calendar_dismissed'));

ALTER TABLE agent_events ADD CONSTRAINT agent_events_router_step_check CHECK (
  (agent = 'router') = (entry_id IS NOT NULL)
  AND (entry_id IS NULL OR task_id IS NULL)
  AND (entry_id IS NOT NULL) = (event_type IN (
    'captured', 'routed', 'needs_owner', 'route_failed', 'derived', 'contact_linked', 'mood_scored',
    'calendar_suggested', 'corrected', 'confirmed', 'contact_chosen', 'calendar_added', 'calendar_dismissed'))
) NOT VALID;

-- Same columns as 0002; router steps left out.
CREATE OR REPLACE VIEW v_public_agent_events AS
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
LEFT JOIN tasks t ON t.id = e.task_id
WHERE e.agent <> 'router';

-- As 0007, plus: a router step is not queued for the office projection.
CREATE OR REPLACE FUNCTION office_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text; v bigint;
BEGIN
 IF TG_TABLE_NAME='agent_events' THEN
  IF NEW.agent='router' THEN RETURN NEW; END IF;
  k:=NEW.id::text; v:=NULL;
 ELSE
  IF TG_OP='UPDATE' AND NEW.office_version=OLD.office_version THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='system_flags' THEN
   IF NEW.key<>'agents_paused' THEN RETURN NEW; END IF;
   k:=NEW.key;
  ELSIF TG_TABLE_NAME='agent_runs' THEN k:=NEW.run_id::text||':'||NEW.run_attempt::text;
  ELSE k:=NEW.id::text;
  END IF;
  v:=NEW.office_version;
 END IF;
 INSERT INTO public.office_outbox(source_table,source_key,source_version) VALUES(TG_TABLE_NAME,k,v);
 RETURN NEW;
END $$;
