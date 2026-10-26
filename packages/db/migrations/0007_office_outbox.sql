-- Source writers enqueue only; office_drain owns projection revisions.
-- The ALTERs (ACCESS EXCLUSIVE) and CREATE TRIGGERs (SHARE ROW EXCLUSIVE) below lock the hot tasks,
-- system_flags and agent_events tables. Fail fast instead of queueing every later reader behind a
-- blocked lock request; the runner wraps each file in its own BEGIN, so SET LOCAL ends with it.
SET LOCAL lock_timeout = '5s';
ALTER TABLE tasks ADD COLUMN office_version bigint NOT NULL DEFAULT 1;
ALTER TABLE system_flags ADD COLUMN office_version bigint NOT NULL DEFAULT 1;
CREATE TABLE agent_runs (
 run_id bigint NOT NULL CHECK(run_id>0), run_attempt integer NOT NULL CHECK(run_attempt>0),
 task_id bigint NOT NULL, role text NOT NULL CHECK(role IN ('developer','qa','docs','scraper')),
 requested_at timestamptz, completed_at timestamptz, conclusion text,
 office_version bigint NOT NULL DEFAULT 1, PRIMARY KEY(run_id,run_attempt)
);
CREATE TABLE office_outbox (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 source_table text NOT NULL, source_key text NOT NULL, source_version bigint,
 enqueued_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','projected','superseded','skipped','dead')),
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text, handled_at timestamptz, revision bigint
);
CREATE INDEX office_outbox_pending ON office_outbox(id) WHERE status='pending';
-- office_drain reports count(dead) on every call; rows are never deleted, so without this the count
-- would scan the whole outbox. Dead (poison) rows are rare, so the partial index stays small.
CREATE INDEX office_outbox_dead ON office_outbox(id) WHERE status='dead';
CREATE TABLE office_source_versions(entity text PRIMARY KEY,version numeric NOT NULL);
CREATE FUNCTION office_outbox_protect() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'office_outbox: retain rows' USING ERRCODE='55000'; END IF;
 IF (NEW.id,NEW.source_table,NEW.source_key,NEW.source_version,NEW.enqueued_at)
 IS DISTINCT FROM (OLD.id,OLD.source_table,OLD.source_key,OLD.source_version,OLD.enqueued_at) THEN
  RAISE EXCEPTION 'office_outbox: immutable source' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER office_outbox_keep BEFORE UPDATE OR DELETE ON office_outbox FOR EACH ROW EXECUTE FUNCTION office_outbox_protect();
CREATE TRIGGER office_outbox_keep_all BEFORE TRUNCATE ON office_outbox FOR EACH STATEMENT EXECUTE FUNCTION office_outbox_protect();
CREATE FUNCTION office_source_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE changed boolean;
BEGIN
 IF TG_OP='INSERT' THEN NEW.office_version:=1; RETURN NEW; END IF;
 IF TG_TABLE_NAME='tasks' THEN
  changed := (NEW.status,NEW.waiting_on,NEW.agent,NEW.public_title,NEW.is_private,NEW.parent_id,NEW.source)
   IS DISTINCT FROM (OLD.status,OLD.waiting_on,OLD.agent,OLD.public_title,OLD.is_private,OLD.parent_id,OLD.source);
 ELSIF TG_TABLE_NAME='system_flags' THEN
  changed := (NEW.key,NEW.value,NEW.updated_at) IS DISTINCT FROM (OLD.key,OLD.value,OLD.updated_at);
 ELSE
  changed := (NEW.task_id,NEW.role,NEW.requested_at,NEW.completed_at,NEW.conclusion)
   IS DISTINCT FROM (OLD.task_id,OLD.role,OLD.requested_at,OLD.completed_at,OLD.conclusion);
 END IF;
 NEW.office_version:=OLD.office_version+CASE WHEN changed THEN 1 ELSE 0 END;
 RETURN NEW;
END $$;
CREATE TRIGGER office_task_version BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION office_source_version();
CREATE TRIGGER office_flag_version BEFORE INSERT OR UPDATE ON system_flags FOR EACH ROW EXECUTE FUNCTION office_source_version();
CREATE TRIGGER office_run_version BEFORE INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION office_source_version();
CREATE FUNCTION office_enqueue() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE k text; v bigint;
BEGIN
 IF TG_TABLE_NAME='agent_events' THEN k:=NEW.id::text; v:=NULL;
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
CREATE TRIGGER office_task_enqueue AFTER INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION office_enqueue();
CREATE TRIGGER office_event_enqueue AFTER INSERT ON agent_events FOR EACH ROW EXECUTE FUNCTION office_enqueue();
CREATE TRIGGER office_flag_enqueue AFTER INSERT OR UPDATE ON system_flags FOR EACH ROW EXECUTE FUNCTION office_enqueue();
CREATE TRIGGER office_run_enqueue AFTER INSERT OR UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION office_enqueue();
-- Current pause only; no historical task/event backfill.
INSERT INTO office_outbox(source_table,source_key,source_version)
 SELECT 'system_flags',key,office_version FROM system_flags WHERE key='agents_paused';
REVOKE ALL ON FUNCTION office_outbox_protect(),office_source_version(),office_enqueue() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON agent_runs TO orch_rw;


-- Seats are allocated at first binding, under the drainer lock, never for an unbound observation.
CREATE FUNCTION office_assignment(p_role text) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
DECLARE station text:=p_role; seat integer;
BEGIN
 IF p_role='developer' THEN
  SELECT n INTO seat FROM generate_series(1,4) n WHERE NOT EXISTS(
   SELECT 1 FROM public.office_tasks a JOIN public.office_executions b ON b.ref=a.execution_ref
   WHERE (a.state IS NULL OR a.state IN ('queued','planning','in_progress','waiting'))
    AND b.station='developer' AND b.seat=n) ORDER BY n LIMIT 1;
  IF seat IS NULL THEN
   station:='annex';
   SELECT n INTO seat FROM generate_series(1,256) n WHERE NOT EXISTS(
    SELECT 1 FROM public.office_tasks a JOIN public.office_executions b ON b.ref=a.execution_ref
    WHERE (a.state IS NULL OR a.state IN ('queued','planning','in_progress','waiting'))
     AND b.station='annex' AND b.seat=n) ORDER BY n LIMIT 1;
  END IF;
 END IF;
 RETURN jsonb_build_object('station',station,'seat',seat);
END $$;
REVOKE ALL ON FUNCTION office_assignment(text) FROM PUBLIC;

CREATE FUNCTION office_drain(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
#variable_conflict use_variable
DECLARE
 o public.office_outbox%ROWTYPE; t public.tasks%ROWTYPE; e public.agent_events%ROWTYPE;
 r public.agent_runs%ROWTYPE; f public.system_flags%ROWTYPE;
 x public.office_executions%ROWTYPE; pt public.office_tasks%ROWTYPE; s public.office_projection_state%ROWTYPE;
 entity text; ver numeric; previous numeric; bind_ver numeric; bind_old numeric;
 transition jsonb; task_item jsonb; exec_item jsonb; task_items jsonb;
 task_id bigint; rev bigint; key text; exec_key text; outcome text; station text; seat integer; reason text; err text;
 projected integer:=0; superseded integer:=0; skipped integer:=0; retried integer:=0;
 processed integer:=0; dead integer; remaining integer;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'office_drain: limit must be 1-100' USING ERRCODE='22023';
 END IF;
 IF NOT pg_try_advisory_xact_lock(701345521) THEN
  RETURN jsonb_build_object('busy',true,'processed',0,'projected',0,'superseded',0,'skipped',0,'retried',0,
   'dead',(SELECT count(*) FROM public.office_outbox WHERE status='dead'),
   'remaining',(SELECT count(*) FROM public.office_outbox WHERE status='pending'));
 END IF;
 FOR o IN SELECT * FROM public.office_outbox WHERE status='pending' AND next_attempt_at<=now()
  ORDER BY id LIMIT p_limit FOR UPDATE LOOP
  processed:=processed+1;
  BEGIN
   entity:=NULL; ver:=NULL; reason:=NULL; transition:='{}'::jsonb;
   bind_ver:=NULL; bind_old:=NULL; task_id:=NULL;
   SELECT * INTO STRICT s FROM public.office_projection_state WHERE id;
   IF o.source_table='tasks' THEN
    SELECT * INTO t FROM public.tasks WHERE id=o.source_key::bigint;
    IF NOT FOUND THEN reason:='source_gone';
    ELSE
     task_id:=t.id; entity:='task:'||t.id; ver:=t.office_version;
     task_item:=jsonb_build_object('task_id',t.id,'is_private',t.is_private,'public_title',t.public_title,
      'kind',CASE WHEN t.source='github' AND t.parent_id IS NOT NULL THEN 'docs' ELSE 'work' END,
      'state',t.status,'waiting_on',CASE WHEN t.status='waiting' THEN t.waiting_on END,'role',t.agent,
      'parent_task_id',t.parent_id,'parent_kind',CASE WHEN t.parent_id IS NULL THEN NULL
       WHEN t.source='github' THEN 'docs_parent' ELSE 'planner_parent' END);
     IF EXISTS(SELECT 1 FROM public.office_tasks a JOIN public.office_refs b ON b.ref=a.ref
      JOIN public.office_executions c ON c.ref=a.execution_ref
      WHERE b.kind='task' AND b.source_key=t.id::text AND c.role IS DISTINCT FROM t.agent) THEN
      task_item:=task_item||jsonb_build_object('execution',NULL);
     END IF;
     -- Reconcile runs that arrived before the task snapshot (or while its role was different).
     SELECT v.version INTO bind_old FROM public.office_source_versions v WHERE v.entity='bind:'||task_id;
     SELECT c.* INTO x FROM public.office_executions c JOIN public.office_refs ref ON ref.ref=c.ref
      JOIN public.agent_runs ar ON ref.source_key='run:'||ar.run_id||':'||ar.run_attempt
      JOIN public.office_refs tr ON tr.ref=c.task_ref AND tr.kind='task' AND tr.source_key=task_id::text
      WHERE c.role=t.agent AND (bind_old IS NULL OR ar.run_id::numeric*2147483648+ar.run_attempt>bind_old)
      ORDER BY ar.run_id DESC,ar.run_attempt DESC LIMIT 1;
     IF FOUND THEN
      SELECT ref.source_key INTO key FROM public.office_refs ref WHERE ref.ref=x.ref;
      SELECT ar.run_id::numeric*2147483648+ar.run_attempt INTO bind_ver FROM public.agent_runs ar
       WHERE key='run:'||ar.run_id||':'||ar.run_attempt;
      task_item:=task_item||jsonb_build_object('execution',key);
      IF x.seat IS NULL THEN
       transition:=jsonb_build_object('executions',jsonb_build_array(jsonb_build_object('key',key)||public.office_assignment(x.role)));
      END IF;
     END IF;
     task_items:=jsonb_build_array(task_item);
     IF t.parent_id IS NOT NULL THEN task_items:=jsonb_build_array(jsonb_build_object('task_id',t.parent_id))||task_items; END IF;
     transition:=transition||jsonb_build_object('tasks',task_items);
    END IF;
   ELSIF o.source_table='system_flags' THEN
    SELECT * INTO f FROM public.system_flags flags WHERE flags.key=o.source_key;
    IF NOT FOUND THEN reason:='source_gone';
    ELSE
     entity:='flag:agents_paused'; ver:=f.office_version;
     transition:=jsonb_build_object('pause',jsonb_build_object('paused',f.value,
      'observed_at',to_char(least(f.updated_at,clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')));
    END IF;
   ELSIF o.source_table='agent_events' THEN
    SELECT * INTO e FROM public.agent_events WHERE id=o.source_key::bigint;
    IF NOT FOUND THEN reason:='source_gone';
    ELSIF e.task_id IS NULL OR e.task_id<=0 THEN reason:='invalid_task';
    ELSIF e.event_type='deployed' AND NOT s.deployment_events THEN reason:='deployment_disabled';
    ELSIF e.agent='router' AND NOT s.routing_events THEN reason:='routing_disabled';
    ELSE
     task_id:=e.task_id;
     transition:=jsonb_build_object('tasks',jsonb_build_array(jsonb_build_object('task_id',task_id)),
      'events',jsonb_build_array(jsonb_build_object('task_id',task_id,'execution',NULL,'role',e.agent,
       'type',e.event_type,'recorded_at',to_char(e.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))));
     IF e.detail->>'source'='report' THEN
      SELECT c.* INTO x FROM public.office_tasks a JOIN public.office_refs b ON b.ref=a.ref
       JOIN public.office_executions c ON c.ref=a.execution_ref
       WHERE b.kind='task' AND b.source_key=task_id::text AND c.role=e.agent AND c.phase<>'terminal'
        AND (c.reported_at IS NULL OR e.ts>c.reported_at)
        AND (SELECT count(*) FROM public.office_executions z WHERE z.task_ref=a.ref AND z.role=e.agent AND z.phase<>'terminal')=1;
      IF FOUND THEN
       SELECT source_key INTO exec_key FROM public.office_refs WHERE ref=x.ref AND kind='execution';
       transition:=transition||jsonb_build_object('executions',jsonb_build_array(jsonb_build_object(
        'key',exec_key,'reported_activity',e.event_type,
        'reported_at',to_char(e.ts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))));
      END IF;
     END IF;
    END IF;
   ELSIF o.source_table='agent_runs' THEN
    SELECT * INTO r FROM public.agent_runs WHERE run_id=split_part(o.source_key,':',1)::bigint AND run_attempt=split_part(o.source_key,':',2)::integer;
    IF NOT FOUND THEN reason:='source_gone';
    ELSIF r.task_id<=0 THEN reason:='invalid_task';
    ELSE
     task_id:=r.task_id; key:='run:'||r.run_id||':'||r.run_attempt; entity:=key; ver:=r.office_version;
     SELECT a.* INTO pt FROM public.office_tasks a JOIN public.office_refs b ON b.ref=a.ref WHERE b.kind='task' AND b.source_key=task_id::text;
     SELECT a.* INTO x FROM public.office_executions a JOIN public.office_refs b ON b.ref=a.ref WHERE b.kind='execution' AND b.source_key=key;
     task_item:=jsonb_build_object('task_id',task_id);
     exec_item:=jsonb_build_object('key',key,'task_id',task_id,'role',r.role);
     IF x.ref IS NULL THEN exec_item:=exec_item||jsonb_build_object('station',r.role); END IF;
     IF x.phase IS DISTINCT FROM 'terminal' THEN
      IF s.execution_observations AND r.completed_at IS NOT NULL THEN
       outcome:=CASE WHEN r.conclusion='success' THEN 'succeeded' WHEN r.conclusion IN ('cancelled','skipped','stale') THEN 'cancelled' ELSE 'failed' END;
       exec_item:=exec_item||jsonb_build_object('phase','terminal','outcome',outcome,'observation_source','trusted_workflow',
        'observed_at',to_char(r.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
      ELSIF s.execution_observations AND r.requested_at IS NOT NULL THEN
       exec_item:=exec_item||jsonb_build_object('phase','starting','observation_source','trusted_workflow',
        'observed_at',to_char(r.requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
      END IF;
     END IF;
     -- Integer attempts are positive and bounded by PostgreSQL int, so this encodes the tuple without collisions.
     bind_ver:=r.run_id::numeric*2147483648+r.run_attempt;
     SELECT v.version INTO bind_old FROM public.office_source_versions v WHERE v.entity='bind:'||task_id;
     IF pt.role=r.role AND (bind_old IS NULL OR bind_ver>bind_old) THEN
      task_item:=task_item||jsonb_build_object('execution',key);
      IF x.seat IS NULL THEN exec_item:=exec_item||public.office_assignment(r.role); END IF;
     ELSE bind_ver:=NULL;
     END IF;
     transition:=jsonb_build_object('tasks',jsonb_build_array(task_item),'executions',jsonb_build_array(exec_item));
    END IF;
   ELSE reason:='unknown_source';
   END IF;
   IF reason IS NOT NULL THEN
    UPDATE public.office_outbox SET status='skipped',last_error=reason,handled_at=now() WHERE id=o.id;
    skipped:=skipped+1;
   ELSE
    previous:=NULL;
    IF entity IS NOT NULL THEN SELECT v.version INTO previous FROM public.office_source_versions v WHERE v.entity=entity; END IF;
    IF previous IS NOT NULL AND ver<=previous THEN
     UPDATE public.office_outbox SET status='superseded',handled_at=now(),last_error=NULL WHERE id=o.id;
     superseded:=superseded+1;
    ELSE
     rev:=public.office_project('outbox:'||o.id,transition);
     IF entity IS NOT NULL THEN
      INSERT INTO public.office_source_versions VALUES(entity,ver) ON CONFLICT ON CONSTRAINT office_source_versions_pkey DO UPDATE SET version=EXCLUDED.version;
     END IF;
     IF bind_ver IS NOT NULL THEN
      INSERT INTO public.office_source_versions VALUES('bind:'||task_id,bind_ver) ON CONFLICT ON CONSTRAINT office_source_versions_pkey DO UPDATE SET version=EXCLUDED.version;
     END IF;
     UPDATE public.office_outbox SET status='projected',revision=rev,handled_at=now(),last_error=NULL WHERE id=o.id;
     projected:=projected+1;
    END IF;
   END IF;
  EXCEPTION WHEN OTHERS THEN
   err:=SQLSTATE;
   IF SQLERRM LIKE 'office_project:%' THEN err:=err||' '||SQLERRM; END IF;
   UPDATE public.office_outbox SET attempts=o.attempts+1,
    status=CASE WHEN SQLSTATE='P0K01' OR o.attempts+1>=8 THEN 'dead' ELSE 'pending' END,
    next_attempt_at=now()+make_interval(secs=>least(30*power(2,least(o.attempts,7)),3600)::integer),
    last_error=err,handled_at=CASE WHEN SQLSTATE='P0K01' OR o.attempts+1>=8 THEN now() END WHERE id=o.id;
   retried:=retried+1;
  END;
 END LOOP;
 SELECT count(*)::integer INTO dead FROM public.office_outbox WHERE status='dead';
 SELECT count(*)::integer INTO remaining FROM public.office_outbox WHERE status='pending';
 RETURN jsonb_build_object('busy',false,'processed',processed,'projected',projected,'superseded',superseded,
  'skipped',skipped,'retried',retried,'dead',dead,'remaining',remaining);
END $$;
REVOKE ALL ON FUNCTION office_drain(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION office_drain(integer) TO orch_rw,web_rw;
