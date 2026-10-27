import type { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGitHubClient } from "../../../agents/orchestrator/src/github";
import { initialTaskData, runStep } from "../../../agents/orchestrator/src/graph";
import { PgTaskStore } from "../../../agents/orchestrator/src/graph/store";
import { parseTaskMessage } from "../../../agents/orchestrator/src/graph/messages";
import { normalize } from "../../../agents/webhook-relay/src/normalize";
import { createTask, setFlag } from "../src/server/console";
import { runAs } from "../src/server/db";
import { drainOffice } from "../src/server/office-drain";
import { readOfficeProjection } from "../src/server/office-projection";
import { queryPublicEvents } from "../src/server/public-feed";
import { parseOfficeEnvelope } from "../src/office-contract";
import { freshDb, pglitePool } from "./pglite";

describe('console to graph to trusted observation to public read adapter',()=>{
 let db:PGlite;
 beforeAll(async()=>{db=await freshDb();});afterAll(async()=>{await db.close();});
 it('shows binding, terminal outcome and pause while preserving the five-field feed',async()=>{
  const pool=pglitePool(db);const owner=<T>(fn:Parameters<typeof runAs<T>>[2])=>runAs(pool,'web_rw',fn);
  const id=await owner(client=>createTask(client,{ownerText:'Add a synthetic status endpoint',isPrivate:false}));
  await owner(drainOffice);
  const store=new PgTaskStore({ ...pool, query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool);
  const deps={store,github:new FakeGitHubClient(),planner:{split:async(req:{owner_text:string})=>[req.owner_text],plan:async()=>({title:'Add a status endpoint',body:'Return synthetic status.'})}};
  await db.query('SET ROLE orch_rw');
  const state=await runStep(id,initialTaskData(),{kind:'start',message_id:'start'},deps);
  await db.query('RESET ROLE');expect(state.phase).toBe('dev');await owner(drainOffice);
  await db.query("SELECT office_project('local-capability','{\"capabilities\":{\"execution_observations\":true}}')");
  const run={id:800,run_attempt:1,path:'.github/workflows/agent-developer.yml',name:'Developer',event:'workflow_dispatch',head_branch:'main',head_sha:'a'.repeat(40),head_repository:{id:1},display_title:`developer task ${id}`,pull_requests:[],run_started_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:01:00Z',conclusion:'success'};
  for(const action of ['requested','completed']){
   const normalized=normalize('workflow_run',{action,repository:{id:1},sender:{id:1,login:'synthetic',type:'Bot'},workflow_run:run});
   if(!normalized.ok)throw Error(normalized.reason);
   const input=parseTaskMessage(JSON.stringify({source:'github',delivery_id:action,task_id:id,thread_id:`task-${id}`,resume:{payload:normalized.value.payload}}),`task-${id}`,action).input;
   await db.query('SET ROLE orch_rw');await runStep(id,state,input,deps);await db.query('RESET ROLE');await owner(drainOffice);
  }
  await owner(client=>setFlag(client,'agents_paused',true));await owner(drainOffice);
  const office=await runAs(pool,'web_public',client=>readOfficeProjection(client,{mode:'bootstrap'}),{readOnly:true});
  expect(parseOfficeEnvelope(office)).toEqual({ok:true,value:office});
  expect(office.snapshot.tasks).toHaveLength(1);expect(office.snapshot.tasks![0]).toMatchObject({description:'Add a status endpoint',role:'developer'});
  expect(office.snapshot.tasks![0]!.execution_ref).toBe(office.snapshot.executions![0]!.ref);
  expect(office.snapshot.executions![0]).toMatchObject({phase:'terminal',outcome:'succeeded',assignment:{station:'developer',seat:1}});
  expect(office.snapshot.pause.paused).toBe(true);
  const feed=await runAs(pool,'web_public',queryPublicEvents,{readOnly:true});
  expect(feed.length).toBeGreaterThan(0);for(const row of feed)expect(Object.keys(row)).toHaveLength(5);
  expect(JSON.stringify(office)).not.toContain('developer task');expect(JSON.stringify(office)).not.toContain('owner_text');
 });
});
