import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/index";
import { freshDb } from "./helpers";

describe("0007 source outbox and projector", () => {
 let pg: PGlite; let db: SqlClient;
 beforeAll(async () => { ({pg,db}=await freshDb()); });
 afterAll(async () => { await pg.close(); });
 const drain=async()=> (await db.query<{r: Record<string,number|boolean>}>("SELECT office_drain(50) AS r")).rows[0]!.r;
 const task=async(title="Example")=> Number((await db.query<{id:number}>("INSERT INTO tasks(source,owner_text,is_private,public_title,agent) VALUES('console','private secret',false,$1,'developer') RETURNING id",[title])).rows[0]!.id);
 it("seeds pause only and atomically enqueues versioned source writes",async()=>{
  expect((await db.query("SELECT * FROM office_outbox")).rows).toHaveLength(1);
  const id=await task();
  expect((await db.query<{v:number}>("SELECT office_version::int v FROM tasks WHERE id=$1",[id])).rows[0]!.v).toBe(1);
  await db.query("UPDATE tasks SET branch='unprojected',office_version=999 WHERE id=$1",[id]);
  expect((await db.query("SELECT * FROM office_outbox WHERE source_table='tasks'")).rows).toHaveLength(1);
  await db.query("UPDATE tasks SET status='planning',office_version=999 WHERE id=$1",[id]);
  expect((await db.query<{v:number}>("SELECT office_version::int v FROM tasks WHERE id=$1",[id])).rows[0]!.v).toBe(2);
  await db.query("BEGIN"); await task("Rolled back"); await db.query("ROLLBACK");
  expect((await db.query("SELECT * FROM office_outbox WHERE source_table='tasks'")).rows).toHaveLength(2);
  const result=await drain(); expect(result.retried).toBe(0); expect(result.projected).toBe(2); expect(result.superseded).toBe(1);
  expect((await db.query("SELECT description,state FROM v_office_tasks")).rows).toEqual([{description:"Example",state:"planning"}]);
 });
 it("does not expose raw outbox or grant projection writer to application roles",async()=>{
  for(const role of ['web_public','web_rw','orch_rw','relay_rw','pipeline_rw']){
   const grants=(await db.query<{raw:boolean;writer:boolean;drain:boolean}>("SELECT has_table_privilege($1,'office_outbox','SELECT') raw, has_function_privilege($1,'office_project(text,jsonb)','EXECUTE') writer, has_function_privilege($1,'office_drain(integer)','EXECUTE') drain",[role])).rows[0]!;
   expect(grants.raw).toBe(false);expect(grants.writer).toBe(false);expect(grants.drain).toBe(['web_rw','orch_rw'].includes(role));
  }
 });
 it("projects event dependencies privately and skips disabled capabilities with reasons",async()=>{
  const id=await task();
  await db.query("INSERT INTO agent_events(task_id,agent,event_type,detail) VALUES($1,'developer','coding','{\"source\":\"report\"}'),($1,'orchestrator','deployed','{}')",[id]);
  expect((await drain()).retried).toBe(0);
  expect((await db.query("SELECT type,description FROM v_office_events")).rows).toEqual([{type:'coding',description:'Example'}]);
  expect((await db.query("SELECT last_error FROM office_outbox WHERE status='skipped'")).rows).toEqual([{last_error:'deployment_disabled'}]);
 });
 it("observes starts/completions, preserves terminal state, and unbinds a changed role",async()=>{
  const id=await task();await drain();
  await db.query("SELECT office_project('capability-test','{\"capabilities\":{\"execution_observations\":true}}')");
  await db.query("INSERT INTO agent_runs(run_id,run_attempt,task_id,role,requested_at) VALUES(100,1001,$1,'developer',now())",[id]);
  let result=await drain(); expect(result.retried).toBe(0);
  expect((await db.query("SELECT phase,station,seat FROM v_office_executions")).rows).toContainEqual({phase:'starting',station:'developer',seat:1});
  await db.query("UPDATE agent_runs SET completed_at=now(),conclusion='success' WHERE run_id=100");
  result=await drain();expect(result.retried).toBe(0);
  expect((await db.query("SELECT phase,outcome FROM v_office_executions")).rows).toContainEqual({phase:'terminal',outcome:'succeeded'});
  await db.query("UPDATE tasks SET agent='qa' WHERE id=$1",[id]);await drain();
  expect((await db.query("SELECT execution_ref FROM v_office_tasks WHERE role='qa'")).rows).toEqual([{execution_ref:null}]);
 });
 it("retries poisoned rows without blocking later rows, then retains dead rows",async()=>{
  await db.query("INSERT INTO office_outbox(source_table,source_key) VALUES('tasks','not an id')");
  await task('Still works');
  let result=await drain();expect(result.retried).toBe(1);expect(result.projected).toBe(1);
  for(let i=0;i<7;i++){
   await db.query("UPDATE office_outbox SET next_attempt_at=now() WHERE status='pending'");result=await drain();
  }
  expect(result.dead).toBe(1);
  expect((await db.query<{last_error:string}>("SELECT last_error FROM office_outbox WHERE status='dead'")).rows[0]!.last_error).toBe('22P02');
  await expect(db.query("DELETE FROM office_outbox")).rejects.toThrow('retain rows');
 });
 it("counts dead and pending rows through partial indexes instead of scanning the retained outbox",async()=>{
  const defs=(await db.query<{indexname:string;indexdef:string}>("SELECT indexname,indexdef FROM pg_indexes WHERE tablename='office_outbox' AND indexname IN ('office_outbox_dead','office_outbox_pending') ORDER BY 1")).rows;
  expect(defs.map(d=>d.indexname)).toEqual(['office_outbox_dead','office_outbox_pending']);
  expect(defs[0]!.indexdef).toMatch(/WHERE \(status = 'dead'::text\)$/);
  // The drain's exact count statements can use them (seqscan disabled only to make the choice visible on a tiny table).
  await db.query("BEGIN"); await db.query("SET LOCAL enable_seqscan=off");
  for(const [status,index] of [['dead','office_outbox_dead'],['pending','office_outbox_pending']] as const){
   const plan=(await db.query<{"QUERY PLAN":string}>(`EXPLAIN SELECT count(*) FROM public.office_outbox WHERE status='${status}'`)).rows.map(r=>r["QUERY PLAN"]).join("\n");
   expect(plan).toContain(index);
  }
  await db.query("ROLLBACK");
  const counts=await drain();
  expect(counts.dead).toBe(Number((await db.query<{n:number}>("SELECT count(*)::int n FROM office_outbox WHERE status='dead'")).rows[0]!.n));
 });
});
