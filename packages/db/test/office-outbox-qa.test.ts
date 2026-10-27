import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SqlClient } from "../src/index";
import { freshDb } from "./helpers";

describe("office outbox independent regressions", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => { ({ pg, db } = await freshDb()); });
  afterAll(async () => { await pg.close(); });
  beforeEach(async () => { await db.query("BEGIN"); });
  afterEach(async () => { await db.query("ROLLBACK"); });
  const drain = async () => (await db.query<{ r: Record<string, number | boolean> }>("SELECT office_drain(100) r")).rows[0]!.r;
  const enable = async () => { await db.query("SELECT office_project('qa-enable','{\"capabilities\":{\"execution_observations\":true}}')"); };
  const task = async () => Number((await db.query<{ id: string }>("INSERT INTO tasks(source,owner_text,is_private,public_title,agent) VALUES('console','private input',false,'Example','developer') RETURNING id")).rows[0]!.id);
  const run = async (taskId: number, id: number, attempt = 1) => {
    await db.query("INSERT INTO agent_runs(run_id,run_attempt,task_id,role,requested_at) VALUES($1,$2,$3,'developer',now())", [id, attempt, taskId]);
  };

  it("reconciles an earlier unbound run when the delayed task snapshot arrives", async () => {
    await enable();
    const id = await task();
    await db.query("UPDATE office_outbox SET next_attempt_at=now()+interval '1 hour' WHERE source_table='tasks'");
    await run(id, 900);
    expect((await drain()).retried).toBe(0);
    expect((await db.query("SELECT execution_ref FROM office_tasks")).rows).toEqual([{ execution_ref: null }]);
    await db.query("UPDATE office_outbox SET next_attempt_at=now() WHERE source_table='tasks'");
    expect((await drain()).retried).toBe(0);
    expect((await db.query<{ bound: boolean }>("SELECT execution_ref IS NOT NULL bound FROM office_tasks")).rows[0]!.bound).toBe(true);
  });

  it("older completions and attempts never replace a newer execution binding", async () => {
    await enable();
    const id = await task();
    await drain();
    await run(id, 100, 1001);
    await drain();
    await run(id, 101, 1);
    await drain();
    await db.query("UPDATE agent_runs SET completed_at=now(),conclusion='failure' WHERE run_id=100");
    expect((await drain()).retried).toBe(0);
    expect((await db.query("SELECT e.source_key FROM office_tasks t JOIN office_refs e ON e.ref=t.execution_ref")).rows).toEqual([{ source_key: "run:101:1" }]);
    expect((await db.query("SELECT phase,outcome FROM office_executions e JOIN office_refs r ON r.ref=e.ref WHERE r.source_key='run:100:1001'")).rows).toEqual([{ phase: "terminal", outcome: "failed" }]);
  });

  it("ambiguous self reports add events without attributing to a run", async () => {
    await enable();
    const id = await task();
    await drain();
    await run(id, 101);
    await run(id, 102);
    await drain();
    await db.query("INSERT INTO agent_events(task_id,agent,event_type,detail) VALUES($1,'developer','coding','{\"source\":\"report\"}')", [id]);
    expect((await drain()).retried).toBe(0);
    expect((await db.query("SELECT reported_activity FROM office_executions")).rows).toEqual([{ reported_activity: null }, { reported_activity: null }]);
    expect((await db.query("SELECT type,execution_ref FROM v_office_events")).rows).toEqual([{ type: "coding", execution_ref: null }]);
  });

  it("raw storage and mutation are denied and definer paths are pinned", async () => {
    for (const role of ["web_public", "web_rw", "orch_rw", "relay_rw", "pipeline_rw"]) {
      for (const table of ["office_outbox", "office_source_versions"]) {
        for (const op of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
          expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege($1,$2,$3) allowed", [role, table, op])).rows[0]!.allowed).toBe(false);
        }
      }
    }
    const functions = (await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] }>("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE proname IN ('office_enqueue','office_drain') ORDER BY proname")).rows;
    expect(functions).toHaveLength(2);
    for (const fn of functions) { expect(fn.prosecdef).toBe(true); expect(fn.proconfig).toContain("search_path=pg_catalog, pg_temp"); }
  });

  it("allocates unique seats when multiple delayed task snapshots bind existing runs", async () => {
    await enable();
    const first = await task();
    const second = await task();
    await db.query("UPDATE office_outbox SET next_attempt_at=now()+interval '1 hour' WHERE source_table='tasks'");
    await run(first, 501); await run(second, 502);
    await drain();
    await db.query("UPDATE office_outbox SET next_attempt_at=now() WHERE source_table='tasks'");
    expect((await drain()).retried).toBe(0);
    const seats = (await db.query<{ seat: number }>("SELECT e.seat FROM office_tasks t JOIN office_executions e ON e.ref=t.execution_ref ORDER BY e.seat")).rows.map((r) => r.seat);
    expect(seats).toEqual([1, 2]);
  });

  it("immediately dead-marks a dedupe mismatch without partial task changes", async () => {
    const id = await task();
    const outboxId = (await db.query<{ id: string }>("SELECT id FROM office_outbox WHERE source_table='tasks' AND source_key=$1", [String(id)])).rows[0]!.id;
    await db.query("SELECT office_project($1,'{}')", ["outbox:" + outboxId]);
    const counts = await drain();
    expect(counts.dead).toBe(1);
    expect((await db.query("SELECT status,attempts,revision FROM office_outbox WHERE id=$1", [outboxId])).rows).toEqual([{ status: "dead", attempts: 1, revision: null }]);
    expect((await db.query("SELECT * FROM office_tasks")).rows).toEqual([]);
    expect((await db.query("SELECT * FROM office_source_versions WHERE entity=$1", ["task:" + id])).rows).toEqual([]);
  });

  it("only a unique nonterminal bound execution receives report annotations", async () => {
    await enable();
    const id = await task(); await drain(); await run(id, 501); await drain();
    await db.query("INSERT INTO agent_events(task_id,agent,event_type,detail) VALUES($1,'developer','coding','{\"source\":\"report\"}')", [id]);
    expect((await drain()).retried).toBe(0);
    expect((await db.query("SELECT reported_activity FROM office_executions")).rows).toEqual([{ reported_activity: "coding" }]);
    await db.query("UPDATE agent_runs SET completed_at=now(),conclusion='success' WHERE run_id=501"); await drain();
    await db.query("INSERT INTO agent_events(task_id,agent,event_type,detail) VALUES($1,'developer','failed','{\"source\":\"report\"}')", [id]);
    expect((await drain()).retried).toBe(0);
    expect((await db.query("SELECT phase,outcome,reported_activity FROM office_executions")).rows).toEqual([{ phase: "terminal", outcome: "succeeded", reported_activity: "coding" }]);
  });
});
