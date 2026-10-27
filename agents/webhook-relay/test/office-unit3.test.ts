import { describe, expect, it } from "vitest";
import { FORWARDED_ACTIONS, normalize } from "../src/normalize";
import { fixture, IDS } from "./helpers";
function payload(){const p=fixture('workflow_run.completed');Object.assign(p.workflow_run,{path:'.github/workflows/agent-developer.yml',event:'workflow_dispatch',head_branch:'main',head_repository:{id:IDS.repo},display_title:'developer task 42',run_attempt:1});return p;}
describe('trusted office run identity',()=>{
 it('derives only the numeric task hint and never forwards display_title',()=>{
  const result=normalize('workflow_run',payload());expect(result.ok).toBe(true);
  if(!result.ok)return;
  expect(result.value.hint.agent_task_id).toBe(42);expect(result.value.payload).toMatchObject({agent_task_id:42});
  expect(JSON.stringify(result.value)).not.toContain('developer task 42');
 });
 it('derives the hint for requested and completed agent runs only; other actions never become observations',()=>{
  for(const action of ['requested','completed']){
   const p=payload();p.action=action;const result=normalize('workflow_run',p);
   expect(result.ok&&result.value.hint.agent_task_id).toBe(42);
  }
  for(const action of ['in_progress','queued','waiting']){
   const p=payload();p.action=action;expect(normalize('workflow_run',p)).toEqual({ok:false,reason:'action'});
  }
  // Defence in depth: even if another workflow_run action were forwarded (for CI runs), an agent run
  // with that action keeps no task hint, so the relay drops it as no_task instead of reaching the PR machine.
  const forwarded=FORWARDED_ACTIONS.workflow_run as string[];forwarded.push('in_progress');
  try{
   const p=payload();p.action='in_progress';const result=normalize('workflow_run',p);expect(result.ok).toBe(true);
   if(!result.ok)return;expect(result.value.hint.agent_task_id).toBeUndefined();expect(result.value.payload).not.toHaveProperty('agent_task_id');
  }finally{forwarded.pop();}
  expect(FORWARDED_ACTIONS.workflow_run).toEqual(['requested','completed']);
 });
 it.each([
  {path:'.github/workflows/not-agent-developer.yml'}, {event:'pull_request'}, {head_branch:'feature'},
  {display_title:'qa task 42'}, {display_title:'developer task 042'}, {display_title:'developer task 0'},
  {display_title:'developer task 9007199254740992'}, {display_title:'developer task 42 secret'}, {head_repository:{id:999}},
 ])('does not derive identity for %j',patch=>{
  const p=payload();Object.assign(p.workflow_run,patch);const result=normalize('workflow_run',p);expect(result.ok).toBe(true);
  if(!result.ok)return;expect(result.value.hint.agent_task_id).toBeUndefined();expect(result.value.payload).not.toHaveProperty('agent_task_id');
  expect(JSON.stringify(result.value)).not.toContain('display_title');
 });
});
