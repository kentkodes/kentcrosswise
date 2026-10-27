import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { MemorySaver } from "@langchain/langgraph";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeGitHubClient } from "../src/github";
import { buildTaskGraph, initialTaskData, processTaskInput, runStep, type TaskInput } from "../src/graph";
import { PgTaskStore } from "../src/graph/store";
import { agentRunRole } from "../src/graph/machine";
import { parseTaskMessage } from "../src/graph/messages";
import { threadConfig } from "../src/handler";

describe('trusted office execution observations',()=>{
 let db:PGlite;let store:PgTaskStore;
 const observation=(taskId:number,action='requested',runId=100):TaskInput=>({kind:'github',event:'workflow_run',action,run_id:runId,run_attempt:1,agent_task_id:taskId,workflow_path:'.github/workflows/agent-developer.yml',head_branch:'main',trigger:'workflow_dispatch',head_sha:'a'.repeat(40),pr_numbers:[],run_started_at:'2099-01-01T00:00:00Z',updated_at:'2099-01-01T00:00:00Z',conclusion:action==='completed'?'success':null,message_id:`${runId}-${action}`});
 const deps=()=>({store,github:new FakeGitHubClient(),planner:{split:async()=>[],plan:async()=>({title:'Synthetic',body:'Synthetic'})}});
 beforeAll(async()=>{
  db=new PGlite();await migrate(fromPglite(db));
  store=new PgTaskStore({query:(sql:string,params:unknown[])=>db.query(sql,params)} as unknown as pg.Pool);
  await db.query("INSERT INTO tasks(source,owner_text,agent) VALUES('console','Synthetic private input','developer')");
 });
 afterAll(async()=>{await db.close();});
 it.each(['dev','ci','qa','merge','done'] as const)('records while paused in %s without driving the loop',async phase=>{
  await db.query("UPDATE system_flags SET value='true' WHERE key='agents_paused'");
  const initial={...initialTaskData(),phase};const next=await runStep(1,initial,observation(1),deps());
  expect(next.phase).toBe(phase);expect(next.stale).toBe(0);expect(next.deferred).toEqual([]);expect(next.last_outcome).toBe('unchanged');
 });
 it('clamps future times, preserves completion without usage and ignores late requests',async()=>{
  await store.recordRun({runId:101,attempt:1,taskId:1,role:'developer',action:'completed',timestamp:'2999-01-01T00:00:00Z',conclusion:'success'});
  await store.recordRun({runId:101,attempt:1,taskId:1,role:'developer',action:'requested',timestamp:'2026-01-01T00:00:00Z',conclusion:null});
  await store.recordRun({runId:101,attempt:1,taskId:1,role:'developer',action:'completed',timestamp:null,conclusion:'failure'});
  expect((await db.query("SELECT conclusion,completed_at<=now() clamped,requested_at IS NULL no_late_start,office_version::int v FROM agent_runs WHERE run_id=101")).rows).toEqual([{conclusion:'success',clamped:true,no_late_start:true,v:1}]);
  await store.recordRun({runId:101,attempt:2,taskId:1,role:'developer',action:'completed',timestamp:'not-date',conclusion:'cancelled'});
  expect((await db.query("SELECT conclusion,completed_at<=now() clamped FROM agent_runs WHERE run_id=101 AND run_attempt=2")).rows).toEqual([{conclusion:'cancelled',clamped:true}]);
 });
 it('accepts observations after the graph is terminal and deduplicates the message',async()=>{
  const graph=buildTaskGraph(new MemorySaver(),deps());
  await graph.invoke({task_id:1,input:observation(1,'completed',102),task:{...initialTaskData(),phase:'done'}},threadConfig(1));
  const late=observation(1,'completed',103);
  expect(await processTaskInput(graph,1,late)).toBe('unchanged');expect(await processTaskInput(graph,1,late)).toBe('duplicate');
  expect((await db.query("SELECT conclusion FROM agent_runs WHERE run_id=103")).rows).toEqual([{conclusion:'success'}]);
 });
 it('validates queue fields and requires explicit relay-derived identity',()=>{
  const input=observation(1);expect(agentRunRole(input,1)).toBe('developer');
  expect(agentRunRole({...input,agent_task_id:2} as TaskInput,1)).toBeNull();
  expect(agentRunRole({...input,run_attempt:2147483648} as TaskInput,1)).toBeNull();
  const p={type:'workflow_run',action:'requested',run_id:200,run_attempt:1001,agent_task_id:1,workflow_path:'.github/workflows/agent-developer.yml',head_branch:'main',trigger:'workflow_dispatch',head_sha:'a'.repeat(40),pr_numbers:[],run_started_at:null,updated_at:null,conclusion:null};
  const parsed=parseTaskMessage(JSON.stringify({source:'github',delivery_id:'synthetic',task_id:1,thread_id:'task-1',resume:{payload:p}}),'task-1','message');
  expect(parsed.input).toMatchObject({run_attempt:1001,agent_task_id:1,head_branch:'main'});
 });
});
