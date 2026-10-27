-- 0006: connected-office public projection (docs/office/LIVE-CONTRACT.md "Consistency, ordering
-- and privacy changes", ordered unit 2). Read side and journal only: no existing writer calls
-- office_project() yet (unit 3), and no role is granted EXECUTE on it here.
--
-- Shape:
--   office_projection_state  one row: generation, current revision, privacy epoch, pause,
--                            capabilities. Its row lock is the transaction-held revision lock.
--   office_refs              opaque random UUIDv4 references -> source keys (task id, execution
--                            key). Server-side only: no view exposes source_key.
--   office_tasks             projected task state (sanitized title, visibility, state, relation)
--   office_executions        projected execution state (unit 3 fills trusted observations)
--   office_journal           append-only events; unique total position (revision, ordinal).
--                            It stores no description: reads take the task's CURRENT title, so a
--                            public -> private change redacts every earlier entry in place.
--   office_source_deliveries source delivery dedupe (one projected transition per key)
--   office_privacy_changes   withdrawn descriptions per privacy epoch (redact / relabel)
-- web_public reads only the v_office_* views below (owner rights, like v_public_agent_events).
-- Existing tables, grants and v_public_agent_events are unchanged.

-- ---------------------------------------------------------------- tables
CREATE TABLE office_projection_state (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  generation             uuid NOT NULL DEFAULT gen_random_uuid(),
  revision               bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  privacy_epoch          bigint NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
  paused                 boolean,
  paused_observed_at     timestamptz,
  -- Capabilities only ever turn on (office_project refuses to turn one off): a missing capability
  -- must not let running/terminal executions, deployed or router events into the projection.
  execution_observations boolean NOT NULL DEFAULT false,
  deployment_events      boolean NOT NULL DEFAULT false,
  routing_events         boolean NOT NULL DEFAULT false,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK ((paused IS NULL) = (paused_observed_at IS NULL)),
  CHECK (isfinite(paused_observed_at) AND paused_observed_at >= '2000-01-01 00:00:00+00')
);
INSERT INTO office_projection_state DEFAULT VALUES;

CREATE TABLE office_refs (
  ref        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('task', 'execution')),
  source_key text NOT NULL CHECK (length(source_key) BETWEEN 1 AND 200),  -- private: never shown
  UNIQUE (kind, source_key)
);

-- No foreign key to tasks: deleting a source task must not silently remove projected history
-- (deletion needs an explicit tombstone, a later unit).
CREATE TABLE office_tasks (
  ref           uuid PRIMARY KEY REFERENCES office_refs (ref),
  is_private    boolean NOT NULL DEFAULT true,
  -- Printable ASCII like the unit-1 transport check; office_project stores NULL otherwise.
  public_title  text CHECK (public_title ~ '^[ -~]{1,60}$' AND btrim(public_title) <> ''),
  kind          text CHECK (kind IN ('work', 'docs')),
  state         text CHECK (state IN (
                  'queued', 'planning', 'in_progress', 'waiting', 'merged', 'done', 'failed', 'cancelled')),
  waiting_on    text CHECK (waiting_on IN ('dev', 'ci', 'qa', 'owner', 'deploy')),
  paused        boolean,
  role          text CHECK (role IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router')),
  execution_ref uuid,                                          -- FK added below (cycle)
  parent_ref    uuid REFERENCES office_tasks (ref),
  parent_kind   text CHECK (parent_kind IN ('docs_parent', 'planner_parent')),
  CHECK (waiting_on IS NULL OR state = 'waiting'),
  CHECK ((parent_ref IS NULL) = (parent_kind IS NULL)),
  CHECK (parent_ref <> ref)
);

-- Single-row rules of the unit-1 OfficeExecution parser; cross-row rules are in office_project.
CREATE TABLE office_executions (
  ref                uuid PRIMARY KEY REFERENCES office_refs (ref),
  task_ref           uuid NOT NULL REFERENCES office_tasks (ref),      -- immutable
  role               text NOT NULL CHECK (role IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router')),
  station            text CHECK (station IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router', 'annex')),
  seat               integer,
  phase              text NOT NULL DEFAULT 'unknown' CHECK (phase IN ('unknown', 'starting', 'running', 'terminal')),
  outcome            text CHECK (outcome IN ('succeeded', 'failed', 'cancelled')),
  observation_source text CHECK (observation_source IN ('trusted_start_report', 'trusted_work_job', 'trusted_workflow')),
  observed_at        timestamptz,
  reported_activity  text CHECK (reported_activity IN (
                       'task_assigned', 'coding', 'pr_opened', 'ci_running', 'tests_failed', 'ci_passed',
                       'qa_reviewing', 'changes_requested', 'approved', 'merged', 'deployed', 'waiting_on_owner',
                       'failed')),
  reported_at        timestamptz,
  CHECK (seat IS NULL OR station IS NOT NULL),
  CHECK (station IS NULL OR station = role OR (station = 'annex' AND role = 'developer')),
  CHECK (seat IS NULL OR (role = 'developer' AND seat BETWEEN 1 AND CASE WHEN station = 'annex' THEN 256 ELSE 4 END)),
  CHECK ((reported_activity IS NULL) = (reported_at IS NULL)),
  CHECK ((observation_source IS NULL) = (observed_at IS NULL)),
  CHECK ((phase = 'unknown') = (observation_source IS NULL)),
  CHECK ((phase = 'terminal') = (outcome IS NOT NULL)),
  CHECK (phase <> 'starting' OR observation_source IN ('trusted_start_report', 'trusted_workflow')),
  CHECK (phase <> 'running' OR observation_source = 'trusted_work_job'),
  CHECK (phase <> 'terminal' OR observation_source <> 'trusted_start_report'),
  CHECK (isfinite(observed_at) AND observed_at >= '2000-01-01 00:00:00+00'),
  CHECK (isfinite(reported_at) AND reported_at >= '2000-01-01 00:00:00+00')
);
ALTER TABLE office_tasks ADD FOREIGN KEY (execution_ref) REFERENCES office_executions (ref);

CREATE TABLE office_journal (
  revision      bigint NOT NULL CHECK (revision > 0),
  ordinal       integer NOT NULL CHECK (ordinal BETWEEN 0 AND 65535),
  ref           uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  recorded_at   timestamptz NOT NULL,
  role          text NOT NULL CHECK (role IN ('orchestrator', 'developer', 'qa', 'scraper', 'docs', 'router')),
  event_type    text NOT NULL CHECK (event_type IN (
                  'task_assigned', 'coding', 'pr_opened', 'ci_running', 'tests_failed', 'ci_passed',
                  'qa_reviewing', 'changes_requested', 'approved', 'merged', 'deployed', 'waiting_on_owner',
                  'failed')),
  task_ref      uuid REFERENCES office_tasks (ref),
  execution_ref uuid REFERENCES office_executions (ref),
  PRIMARY KEY (revision, ordinal),
  CHECK (task_ref IS NOT NULL OR execution_ref IS NULL),
  CHECK (isfinite(recorded_at) AND recorded_at >= '2000-01-01 00:00:00+00')
);

-- digest = sha256 of the transition's canonical jsonb text (core sha256(), no extension). It only
-- tells a redelivery (same content: no-op) from a reused key (different content: error); it is
-- not a security boundary.
CREATE TABLE office_source_deliveries (
  source_key   text PRIMARY KEY CHECK (length(source_key) BETWEEN 1 AND 200),  -- private
  digest       bytea NOT NULL CHECK (length(digest) = 32),
  revision     bigint NOT NULL,
  projected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE office_privacy_changes (
  privacy_epoch bigint NOT NULL,
  task_ref      uuid NOT NULL REFERENCES office_tasks (ref),
  kind          text NOT NULL CHECK (kind IN ('redact', 'relabel')),   -- what happened at that epoch
  revision      bigint NOT NULL,
  PRIMARY KEY (privacy_epoch, task_ref)
);

-- The journal is append-only (no pruning in this unit; retention is a separate decision).
CREATE FUNCTION office_journal_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'office_journal is append-only' USING ERRCODE = '55000';
END
$$;
CREATE TRIGGER office_journal_no_update BEFORE UPDATE OR DELETE ON office_journal
  FOR EACH ROW EXECUTE FUNCTION office_journal_append_only();
CREATE TRIGGER office_journal_no_truncate BEFORE TRUNCATE ON office_journal
  FOR EACH STATEMENT EXECUTE FUNCTION office_journal_append_only();

-- ---------------------------------------------------------------- writer
-- Strict ISO-8601 timestamp for office_project: finite, not before 2000-01-01Z, not after p_now.
-- Fixed error text: the input never appears in a message (casts are checked by format first and
-- any remaining cast error is replaced).
CREATE FUNCTION office_project_timestamp(p_value text, p_now timestamptz) RETURNS timestamptz
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v timestamptz;
BEGIN
  IF p_value IS NULL
     OR p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
    RAISE EXCEPTION 'office_project: timestamps must be ISO-8601 with a zone' USING ERRCODE = '22007';
  END IF;
  BEGIN
    v := p_value::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'office_project: timestamps must be ISO-8601 with a zone' USING ERRCODE = '22007';
  END;
  IF NOT isfinite(v) OR v < '2000-01-01 00:00:00+00'::timestamptz OR v > p_now THEN
    RAISE EXCEPTION 'office_project: timestamp out of range (before 2000 or in the future)' USING ERRCODE = '22008';
  END IF;
  RETURN v;
END
$$;

-- office_project(source_key, transition) projects ONE committed transition and returns its
-- revision, or NULL when source_key was already projected with the same content (redelivery: no
-- change). The same key with different content raises SQLSTATE P0K01 (custom, fixed message
-- 'office_project: source key was already projected with different content'): a reused or
-- corrupted key, not a retryable conflict; unit-3 writers should treat it as a bug, not retry.
-- It runs inside the caller's transaction, so the caller's source writes, the journal entries and
-- the projection state commit or roll back together (a rollback leaves no revision, reference,
-- journal or dedupe residue; revisions are a counter, not a sequence, so no gap either).
--
-- Order matters: (1) lock the state row FOR UPDATE, held until the transaction ends; (2) only
-- then check dedupe (a concurrent duplicate that committed first is visible after the wait in
-- READ COMMITTED; REPEATABLE READ callers get a retryable serialization failure instead);
-- (3) allocate revision + 1. Writers therefore commit in revision order, so a reader's snapshot
-- always holds a gap-free prefix of (revision, ordinal) positions, whatever order the source
-- events were created in. Events of one transition get ordinals 0, 1, ...
--
-- SECURITY DEFINER so writer roles (unit 3) need only EXECUTE and can never write the tables
-- directly, i.e. cannot bypass the lock order, forge positions or skip validation. search_path is
-- pinned and every object is schema-qualified. EXECUTE is revoked from PUBLIC and granted to
-- nobody in this migration.
--
-- transition (jsonb object; unknown keys are rejected; every key optional):
--   capabilities {execution_observations?, deployment_events?, routing_events?}: true only
--   pause        {paused: boolean|null, observed_at?: timestamptz}
--   tasks        [{task_id, is_private?, public_title?, kind?, state?, waiting_on?, paused?, role?,
--                  execution?: key|null, parent_task_id?: id|null, parent_kind?}]  (partial update)
--   executions   [{key, task_id?, role?, station?, seat?, phase?, outcome?, observation_source?,
--                  observed_at?, reported_activity?, reported_at?}]  (task_id/role on creation)
--   events       [{task_id: id|null, execution?: key|null, role, type, recorded_at?}]
-- A task becoming private, or a public title changing, withdraws its old description: the
-- privacy epoch goes up once for the transition and office_privacy_changes records why.
-- A public_title failing the printable-ASCII 1-60 check is stored as NULL ("Private task").
-- A terminal execution keeps its phase and outcome (a late report cannot revive it), and parent
-- links cannot form a cycle.
-- Error messages name the rule, never input values: any other error (cast, constraint) is
-- re-raised as 'office_project: rejected (<SQLSTATE>)' with the same SQLSTATE and no detail.
CREATE FUNCTION office_project(p_source_key text, p_transition jsonb) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_state   public.office_projection_state%ROWTYPE;
  v_rev     bigint;
  v_epoch   bigint;
  v_stamp   timestamptz := clock_timestamp();
  v_item    jsonb;
  v_task    public.office_tasks%ROWTYPE;
  v_exec    public.office_executions%ROWTYPE;
  v_id      bigint;
  v_ref     uuid;
  v_ref2    uuid;
  v_key     text;
  v_private boolean;
  v_title   text;
  v_old     text;
  v_new     text;
  v_ts      timestamptz;
  v_ts2     timestamptz;
  v_ord     integer := -1;
  v_tasks   uuid[] := '{}';
  v_execs   uuid[] := '{}';
  v_gone    uuid[] := '{}';
  v_why     text[] := '{}';
  v_digest  bytea;
  v_prev    bytea;
  v_final   boolean;
BEGIN
 BEGIN
  IF p_source_key IS NULL OR length(p_source_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'office_project: source key must be 1-200 characters' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_transition) IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_transition) k
                WHERE k NOT IN ('capabilities', 'pause', 'tasks', 'executions', 'events')) THEN
    RAISE EXCEPTION 'office_project: transition must be an object with known keys' USING ERRCODE = '22023';
  END IF;

  -- (1) The revision lock, before any allocation or projection write.
  SELECT * INTO STRICT v_state FROM public.office_projection_state WHERE id FOR UPDATE;
  -- (2) Dedupe under the lock.
  v_digest := sha256(convert_to(p_transition::text, 'UTF8'));
  SELECT d.digest INTO v_prev FROM public.office_source_deliveries d WHERE d.source_key = p_source_key;
  IF FOUND THEN
    IF v_prev = v_digest THEN
      RETURN NULL;
    END IF;
    RAISE EXCEPTION 'office_project: source key was already projected with different content' USING ERRCODE = 'P0K01';
  END IF;
  -- (3) Allocate.
  v_rev := v_state.revision + 1;
  v_epoch := v_state.privacy_epoch;
  INSERT INTO public.office_source_deliveries (source_key, digest, revision) VALUES (p_source_key, v_digest, v_rev);

  -- ------------------------------------------------ capabilities (monotonic)
  IF p_transition ? 'capabilities' THEN
    v_item := p_transition -> 'capabilities';
    IF jsonb_typeof(v_item) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(v_item) e
                  WHERE e.key NOT IN ('execution_observations', 'deployment_events', 'routing_events')
                     OR e.value <> 'true'::jsonb) THEN
      RAISE EXCEPTION 'office_project: capabilities can only be turned on' USING ERRCODE = '22023';
    END IF;
    v_state.execution_observations := v_state.execution_observations OR v_item ? 'execution_observations';
    v_state.deployment_events := v_state.deployment_events OR v_item ? 'deployment_events';
    v_state.routing_events := v_state.routing_events OR v_item ? 'routing_events';
  END IF;

  -- ------------------------------------------------ pause
  IF p_transition ? 'pause' THEN
    v_item := p_transition -> 'pause';
    IF jsonb_typeof(v_item) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k WHERE k NOT IN ('paused', 'observed_at'))
       OR COALESCE(jsonb_typeof(v_item -> 'paused'), 'missing') NOT IN ('boolean', 'null')
       OR (v_item ? 'observed_at' AND jsonb_typeof(v_item -> 'observed_at') <> 'string') THEN
      RAISE EXCEPTION 'office_project: bad pause' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_item -> 'paused') = 'null' THEN
      v_state.paused := NULL;
      v_state.paused_observed_at := NULL;
    ELSE
      v_state.paused := (v_item -> 'paused')::boolean;
      v_state.paused_observed_at := CASE WHEN v_item ? 'observed_at'
        THEN public.office_project_timestamp(v_item ->> 'observed_at', v_stamp) ELSE v_stamp END;
    END IF;
  END IF;

  -- ------------------------------------------------ tasks, pass 1: references and rows
  IF jsonb_typeof(COALESCE(p_transition -> 'tasks', '[]')) <> 'array'
     OR jsonb_typeof(COALESCE(p_transition -> 'executions', '[]')) <> 'array'
     OR jsonb_typeof(COALESCE(p_transition -> 'events', '[]')) <> 'array' THEN
    RAISE EXCEPTION 'office_project: tasks, executions and events must be arrays' USING ERRCODE = '22023';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_transition -> 'tasks', '[]')) LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(v_item) e WHERE e.key NOT IN (
                    'task_id', 'is_private', 'public_title', 'kind', 'state', 'waiting_on', 'paused', 'role',
                    'execution', 'parent_task_id', 'parent_kind'))
       OR EXISTS (SELECT 1 FROM jsonb_each(v_item) e
                  WHERE e.key IN ('public_title', 'kind', 'state', 'waiting_on', 'role', 'execution', 'parent_kind')
                    AND jsonb_typeof(e.value) NOT IN ('string', 'null'))
       OR jsonb_typeof(v_item -> 'task_id') IS DISTINCT FROM 'number'
       OR (v_item ? 'is_private' AND jsonb_typeof(v_item -> 'is_private') <> 'boolean')
       OR (v_item ? 'paused' AND jsonb_typeof(v_item -> 'paused') NOT IN ('boolean', 'null'))
       OR (v_item ? 'parent_task_id') <> (v_item ? 'parent_kind')
       OR (v_item ? 'parent_task_id' AND jsonb_typeof(v_item -> 'parent_task_id') NOT IN ('number', 'null')) THEN
      RAISE EXCEPTION 'office_project: bad task' USING ERRCODE = '22023';
    END IF;
    v_id := (v_item ->> 'task_id')::bigint;
    IF v_id <= 0 THEN
      RAISE EXCEPTION 'office_project: bad task id' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.office_refs (kind, source_key) VALUES ('task', v_id::text) ON CONFLICT (kind, source_key) DO NOTHING;
    SELECT r.ref INTO STRICT v_ref FROM public.office_refs r WHERE r.kind = 'task' AND r.source_key = v_id::text;
    IF v_ref = ANY (v_tasks) THEN
      RAISE EXCEPTION 'office_project: task listed twice' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.office_tasks (ref) VALUES (v_ref) ON CONFLICT (ref) DO NOTHING;
    v_tasks := v_tasks || v_ref;
  END LOOP;

  -- ------------------------------------------------ tasks, pass 2: fields (not execution)
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_transition -> 'tasks', '[]')) LOOP
    SELECT t.* INTO STRICT v_task FROM public.office_tasks t
      JOIN public.office_refs r ON r.ref = t.ref
     WHERE r.kind = 'task' AND r.source_key = (v_item ->> 'task_id')::bigint::text;
    v_old := CASE WHEN v_task.is_private OR v_task.public_title IS NULL THEN NULL ELSE v_task.public_title END;
    v_private := CASE WHEN v_item ? 'is_private' THEN (v_item -> 'is_private')::boolean ELSE v_task.is_private END;
    v_title := CASE WHEN v_item ? 'public_title' THEN v_item ->> 'public_title' ELSE v_task.public_title END;
    IF v_title IS NOT NULL AND NOT (v_title ~ '^[ -~]{1,60}$' AND btrim(v_title) <> '') THEN
      v_title := NULL;                                        -- fail closed: "Private task"
    END IF;
    v_ref2 := v_task.parent_ref;
    IF v_item ? 'parent_task_id' THEN
      IF jsonb_typeof(v_item -> 'parent_task_id') = 'null' THEN
        v_ref2 := NULL;
      ELSE
        SELECT t.ref INTO v_ref2 FROM public.office_tasks t JOIN public.office_refs r ON r.ref = t.ref
         WHERE r.kind = 'task' AND r.source_key = (v_item ->> 'parent_task_id')::bigint::text;
        IF v_ref2 IS NULL THEN
          RAISE EXCEPTION 'office_project: parent task is not projected' USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
    UPDATE public.office_tasks SET
      is_private   = v_private,
      public_title = v_title,
      kind         = CASE WHEN v_item ? 'kind' THEN v_item ->> 'kind' ELSE kind END,
      state        = CASE WHEN v_item ? 'state' THEN v_item ->> 'state' ELSE state END,
      waiting_on   = CASE WHEN v_item ? 'waiting_on' THEN v_item ->> 'waiting_on' ELSE waiting_on END,
      paused       = CASE WHEN v_item ? 'paused' THEN (NULLIF(v_item -> 'paused', 'null'::jsonb))::boolean ELSE paused END,
      role         = CASE WHEN v_item ? 'role' THEN v_item ->> 'role' ELSE role END,
      parent_ref   = v_ref2,
      parent_kind  = CASE WHEN v_item ? 'parent_kind' THEN v_item ->> 'parent_kind' ELSE parent_kind END
    WHERE ref = v_task.ref;
    v_new := CASE WHEN v_private OR v_title IS NULL THEN NULL ELSE v_title END;
    IF v_old IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN
      v_gone := v_gone || v_task.ref;
      v_why := v_why || CASE WHEN v_new IS NULL THEN 'redact' ELSE 'relabel' END;
    END IF;
  END LOOP;

  -- ------------------------------------------------ executions
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_transition -> 'executions', '[]')) LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(v_item) e WHERE e.key NOT IN (
                    'key', 'task_id', 'role', 'station', 'seat', 'phase', 'outcome', 'observation_source',
                    'observed_at', 'reported_activity', 'reported_at'))
       OR EXISTS (SELECT 1 FROM jsonb_each(v_item) e
                  WHERE e.key IN ('role', 'station', 'phase', 'outcome', 'observation_source', 'observed_at',
                                  'reported_activity', 'reported_at')
                    AND jsonb_typeof(e.value) NOT IN ('string', 'null'))
       OR jsonb_typeof(v_item -> 'key') IS DISTINCT FROM 'string'
       OR (v_item ? 'task_id' AND jsonb_typeof(v_item -> 'task_id') <> 'number')
       OR (v_item ? 'seat' AND jsonb_typeof(v_item -> 'seat') NOT IN ('number', 'null')) THEN
      RAISE EXCEPTION 'office_project: bad execution' USING ERRCODE = '22023';
    END IF;
    v_key := v_item ->> 'key';
    IF length(v_key) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'office_project: execution key must be 1-200 characters' USING ERRCODE = '22023';
    END IF;
    v_ref2 := NULL;
    IF v_item ? 'task_id' THEN
      SELECT t.ref INTO v_ref2 FROM public.office_tasks t JOIN public.office_refs r ON r.ref = t.ref
       WHERE r.kind = 'task' AND r.source_key = (v_item ->> 'task_id')::bigint::text;
      IF v_ref2 IS NULL THEN
        RAISE EXCEPTION 'office_project: execution task is not projected' USING ERRCODE = '22023';
      END IF;
    END IF;
    INSERT INTO public.office_refs (kind, source_key) VALUES ('execution', v_key) ON CONFLICT (kind, source_key) DO NOTHING;
    SELECT r.ref INTO STRICT v_ref FROM public.office_refs r WHERE r.kind = 'execution' AND r.source_key = v_key;
    IF v_ref = ANY (v_execs) THEN
      RAISE EXCEPTION 'office_project: execution listed twice' USING ERRCODE = '22023';
    END IF;
    v_execs := v_execs || v_ref;
    SELECT * INTO v_exec FROM public.office_executions WHERE ref = v_ref;
    IF NOT FOUND THEN
      IF v_ref2 IS NULL OR v_item ->> 'role' IS NULL THEN
        RAISE EXCEPTION 'office_project: a new execution needs task_id and role' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.office_executions (ref, task_ref, role) VALUES (v_ref, v_ref2, v_item ->> 'role');
    ELSIF (v_ref2 IS NOT NULL AND v_ref2 <> v_exec.task_ref)
       OR (v_item ? 'role' AND (v_item ->> 'role') IS DISTINCT FROM v_exec.role) THEN
      RAISE EXCEPTION 'office_project: execution task and role are immutable' USING ERRCODE = '22023';
    END IF;
    v_ts := CASE WHEN jsonb_typeof(v_item -> 'observed_at') = 'string'
      THEN public.office_project_timestamp(v_item ->> 'observed_at', v_stamp) END;
    v_ts2 := CASE WHEN jsonb_typeof(v_item -> 'reported_at') = 'string'
      THEN public.office_project_timestamp(v_item ->> 'reported_at', v_stamp) END;
    v_final := v_exec.phase = 'terminal';
    v_old := v_exec.outcome;
    UPDATE public.office_executions SET
      station            = CASE WHEN v_item ? 'station' THEN v_item ->> 'station' ELSE station END,
      seat               = CASE WHEN v_item ? 'seat' THEN (v_item ->> 'seat')::integer ELSE seat END,
      phase              = CASE WHEN v_item ? 'phase' THEN v_item ->> 'phase' ELSE phase END,
      outcome            = CASE WHEN v_item ? 'outcome' THEN v_item ->> 'outcome' ELSE outcome END,
      observation_source = CASE WHEN v_item ? 'observation_source' THEN v_item ->> 'observation_source' ELSE observation_source END,
      observed_at        = CASE WHEN v_item ? 'observed_at' THEN v_ts ELSE observed_at END,
      reported_activity  = CASE WHEN v_item ? 'reported_activity' THEN v_item ->> 'reported_activity' ELSE reported_activity END,
      reported_at        = CASE WHEN v_item ? 'reported_at' THEN v_ts2 ELSE reported_at END
    WHERE ref = v_ref
    RETURNING * INTO v_exec;
    IF v_final AND (v_exec.phase <> 'terminal' OR v_exec.outcome IS DISTINCT FROM v_old) THEN
      RAISE EXCEPTION 'office_project: a terminal execution cannot change phase or outcome' USING ERRCODE = '22023';
    END IF;
    IF (v_exec.phase IN ('running', 'terminal') OR (v_exec.phase = 'starting' AND v_exec.observation_source = 'trusted_workflow')) AND NOT v_state.execution_observations THEN
      RAISE EXCEPTION 'office_project: execution observations are not available' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- ------------------------------------------------ tasks, pass 3: current execution
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_transition -> 'tasks', '[]')) LOOP
    CONTINUE WHEN NOT v_item ? 'execution';
    v_ref2 := NULL;
    IF jsonb_typeof(v_item -> 'execution') = 'string' THEN
      SELECT x.ref INTO v_ref2 FROM public.office_executions x JOIN public.office_refs r ON r.ref = x.ref
       WHERE r.kind = 'execution' AND r.source_key = v_item ->> 'execution';
      IF v_ref2 IS NULL THEN
        RAISE EXCEPTION 'office_project: task execution is not projected' USING ERRCODE = '22023';
      END IF;
    END IF;
    UPDATE public.office_tasks t SET execution_ref = v_ref2
      FROM public.office_refs r
     WHERE r.ref = t.ref AND r.kind = 'task' AND r.source_key = (v_item ->> 'task_id')::bigint::text;
  END LOOP;

  -- ------------------------------------------------ events: one ordinal each
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_transition -> 'events', '[]')) LOOP
    IF jsonb_typeof(v_item) <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(v_item) k
                  WHERE k NOT IN ('task_id', 'execution', 'role', 'type', 'recorded_at'))
       OR COALESCE(jsonb_typeof(v_item -> 'task_id'), 'missing') NOT IN ('number', 'null')
       OR (v_item ? 'execution' AND jsonb_typeof(v_item -> 'execution') NOT IN ('string', 'null'))
       OR jsonb_typeof(v_item -> 'role') IS DISTINCT FROM 'string'
       OR jsonb_typeof(v_item -> 'type') IS DISTINCT FROM 'string'
       OR (v_item ? 'recorded_at' AND jsonb_typeof(v_item -> 'recorded_at') <> 'string') THEN
      RAISE EXCEPTION 'office_project: bad event' USING ERRCODE = '22023';
    END IF;
    v_ord := v_ord + 1;
    v_ref := NULL;
    IF jsonb_typeof(v_item -> 'task_id') = 'number' THEN
      SELECT t.ref INTO v_ref FROM public.office_tasks t JOIN public.office_refs r ON r.ref = t.ref
       WHERE r.kind = 'task' AND r.source_key = (v_item ->> 'task_id')::bigint::text;
      IF v_ref IS NULL THEN
        RAISE EXCEPTION 'office_project: event task is not projected' USING ERRCODE = '22023';
      END IF;
    END IF;
    v_ref2 := NULL;
    IF jsonb_typeof(v_item -> 'execution') = 'string' THEN
      SELECT x.ref INTO v_ref2 FROM public.office_executions x JOIN public.office_refs r ON r.ref = x.ref
       WHERE r.kind = 'execution' AND r.source_key = v_item ->> 'execution'
         AND x.task_ref = v_ref AND x.role = v_item ->> 'role';
      IF v_ref2 IS NULL THEN
        RAISE EXCEPTION 'office_project: event execution must exist for the same task and role' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_item ->> 'type' = 'deployed' AND NOT v_state.deployment_events
       OR v_item ->> 'role' = 'router' AND NOT v_state.routing_events THEN
      RAISE EXCEPTION 'office_project: event capability is not available' USING ERRCODE = '22023';
    END IF;
    v_ts := CASE WHEN v_item ? 'recorded_at'
      THEN public.office_project_timestamp(v_item ->> 'recorded_at', v_stamp) ELSE v_stamp END;
    INSERT INTO public.office_journal (revision, ordinal, recorded_at, role, event_type, task_ref, execution_ref)
    VALUES (v_rev, v_ord, v_ts, v_item ->> 'role', v_item ->> 'type', v_ref, v_ref2);
  END LOOP;

  -- ------------------------------------------------ cross-row rules (unit-1 association checks)
  IF EXISTS (SELECT 1 FROM public.office_tasks t JOIN public.office_executions x ON x.ref = t.execution_ref
              WHERE (t.ref = ANY (v_tasks) OR x.ref = ANY (v_execs))
                AND (x.task_ref <> t.ref OR (t.role IS NOT NULL AND x.role <> t.role))) THEN
    RAISE EXCEPTION 'office_project: task execution must belong to the task and its role' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.office_tasks c JOIN public.office_tasks p ON p.ref = c.parent_ref
              WHERE (c.ref = ANY (v_tasks) OR p.ref = ANY (v_tasks))
                AND c.parent_kind = 'docs_parent' AND (c.kind = 'work' OR p.kind = 'docs')) THEN
    RAISE EXCEPTION 'office_project: a docs_parent relation links a docs child to a non-docs parent' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (WITH RECURSIVE up (start, ref, depth) AS (
               SELECT t.ref, t.parent_ref, 1 FROM public.office_tasks t
                WHERE t.ref = ANY (v_tasks) AND t.parent_ref IS NOT NULL
               UNION ALL
               SELECT u.start, p.parent_ref, u.depth + 1 FROM up u JOIN public.office_tasks p ON p.ref = u.ref
                WHERE p.parent_ref IS NOT NULL AND u.ref <> u.start AND u.depth < 10000)
             SELECT 1 FROM up WHERE up.ref = up.start) THEN
    RAISE EXCEPTION 'office_project: parent links cannot form a cycle' USING ERRCODE = '22023';
  END IF;

  -- ------------------------------------------------ privacy epoch and state
  IF cardinality(v_gone) > 0 THEN
    v_epoch := v_epoch + 1;
    INSERT INTO public.office_privacy_changes (privacy_epoch, task_ref, kind, revision)
    SELECT v_epoch, g.ref, g.why, v_rev FROM unnest(v_gone, v_why) AS g (ref, why);
  END IF;
  UPDATE public.office_projection_state SET
    revision               = v_rev,
    privacy_epoch          = v_epoch,
    paused                 = v_state.paused,
    paused_observed_at     = v_state.paused_observed_at,
    execution_observations = v_state.execution_observations,
    deployment_events      = v_state.deployment_events,
    routing_events         = v_state.routing_events,
    updated_at             = v_stamp
  WHERE id;
  RETURN v_rev;
 EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE 'office_project:%' THEN
    RAISE;                                                    -- our own fixed message
  END IF;
  RAISE EXCEPTION 'office_project: rejected (%)', SQLSTATE USING ERRCODE = SQLSTATE;
 END;
END
$$;

-- ---------------------------------------------------------------- public views
-- Owner rights, like v_public_agent_events: web_public needs no grant on the tables. They expose
-- prefixed opaque references and sanitized fields only, never source_key, task ids, owner text,
-- event detail or source dedupe keys. Timestamps are UTC milliseconds (unit-1 format).
-- Private tasks and tasks without a public title show exactly 'Private task'.
CREATE VIEW v_office_state AS
SELECT
  'gen_' || s.generation::text AS generation,
  s.revision,
  s.privacy_epoch,
  COALESCE((SELECT max(j.ordinal) FROM office_journal j WHERE j.revision = s.revision), 0) AS watermark_ordinal,
  o.revision AS oldest_revision,
  o.ordinal AS oldest_ordinal,
  s.paused,
  to_char(s.paused_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS paused_observed_at,
  s.execution_observations,
  s.deployment_events,
  s.routing_events
FROM office_projection_state s
LEFT JOIN LATERAL (
  SELECT j.revision, j.ordinal FROM office_journal j ORDER BY j.revision, j.ordinal LIMIT 1
) o ON true;

CREATE VIEW v_office_tasks AS
SELECT
  'task_' || t.ref::text AS ref,
  CASE WHEN t.is_private OR t.public_title IS NULL THEN 'private' ELSE 'public' END AS visibility,
  CASE WHEN t.is_private OR t.public_title IS NULL THEN 'Private task' ELSE t.public_title END AS description,
  t.kind,
  t.state,
  t.waiting_on,
  t.paused,
  t.role,
  'exec_' || t.execution_ref::text AS execution_ref,
  'task_' || t.parent_ref::text AS parent_ref,
  t.parent_kind,
  (t.state IS NULL OR t.state IN ('queued', 'planning', 'in_progress', 'waiting')) AS active
FROM office_tasks t;

CREATE VIEW v_office_executions AS
SELECT
  'exec_' || x.ref::text AS ref,
  'task_' || x.task_ref::text AS task_ref,
  x.role,
  x.station,
  x.seat,
  x.phase,
  x.outcome,
  x.observation_source,
  to_char(x.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
  x.reported_activity,
  to_char(x.reported_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS reported_at
FROM office_executions x;

-- Descriptions come from the task's current projection, so redaction applies to every earlier
-- journal entry at read time (LIVE-CONTRACT: "redact old journal payloads using current policy").
CREATE VIEW v_office_events AS
SELECT
  'event_' || j.ref::text AS ref,
  j.revision,
  j.ordinal,
  to_char(j.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
  j.role,
  j.event_type AS type,
  'task_' || j.task_ref::text AS task_ref,
  'exec_' || j.execution_ref::text AS execution_ref,
  CASE WHEN t.ref IS NULL OR t.is_private OR t.public_title IS NULL THEN 'private' ELSE 'public' END AS visibility,
  CASE WHEN t.ref IS NULL OR t.is_private OR t.public_title IS NULL THEN 'Private task' ELSE t.public_title END AS description
FROM office_journal j
LEFT JOIN office_tasks t ON t.ref = j.task_ref
-- Defensive read guard: the table CHECK already refuses such rows; if one ever existed it would
-- be skipped (a hole in ordinals, never a malformed timestamp that fails every read).
WHERE isfinite(j.recorded_at) AND j.recorded_at >= '2000-01-01 00:00:00+00';

-- Every withdrawn public description per epoch, whatever happened since (a task made private
-- and later public again under another title still withdraws the first title). The kind follows
-- the task's CURRENT visibility, so a history mixing redact and a later republish yields one
-- consistent kind: 'redact' = private now ("Private task"), 'relabel' = public now under its
-- current row, which the adapter adds to the snapshot. Either way the client purges old labels.
CREATE VIEW v_office_invalidations AS
SELECT
  c.privacy_epoch,
  'task_' || c.task_ref::text AS task_ref,
  CASE WHEN t.is_private OR t.public_title IS NULL THEN 'redact' ELSE 'relabel' END AS kind
FROM office_privacy_changes c
JOIN office_tasks t ON t.ref = c.task_ref;

-- ---------------------------------------------------------------- grants
-- web_public: SELECT on the five sanitized views, nothing on the tables or functions.
GRANT SELECT ON v_office_state, v_office_tasks, v_office_executions, v_office_events, v_office_invalidations
TO web_public;
-- Functions get EXECUTE for PUBLIC by default: remove it. office_project is granted to writer
-- roles in unit 3; the trigger function needs no grant to fire.
REVOKE ALL ON FUNCTION office_project(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION office_project_timestamp(text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION office_journal_append_only() FROM PUBLIC;
