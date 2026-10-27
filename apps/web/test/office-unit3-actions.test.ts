import { afterEach, describe, expect, it, vi } from "vitest";
const f=vi.hoisted(()=>({withDb:vi.fn(),createTask:vi.fn(),setFlag:vi.fn(),trySend:vi.fn(),requireOwner:vi.fn(),redirect:vi.fn(),error:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:f.redirect}));
vi.mock('@/server/db',()=>({withDb:f.withDb}));
vi.mock('../src/server/db',()=>({withDb:f.withDb}));
vi.mock('@/server/owner',()=>({requireOwner:f.requireOwner}));
vi.mock('@/server/console',()=>({createTask:f.createTask,setFlag:f.setFlag,isFlagKey:(key:unknown)=>['agents_paused','pipelines_paused'].includes(String(key)),parseTaskId:()=>undefined,queuedTaskExists:vi.fn()}));
vi.mock('@/server/orchestrator-queue',()=>({orchestratorQueue:()=>({}),taskCreatedMessage:(id:number)=>({task_id:id}),trySend:f.trySend}));
vi.mock('../src/app/(owner)/notices',()=>({failureNotice:()=>"db-error"}));
vi.mock('@/server/office-drain',async()=>{
 // Exercise the real maintenance boundary, with its own failed transaction.
 const {tryDrainOffice}=await import('../src/server/office-drain');return {tryDrainOffice};
});
import { createTaskAction, setFlagAction } from "../src/app/(owner)/console/actions";
afterEach(()=>{vi.restoreAllMocks();vi.resetAllMocks();});
describe('owner action results survive office maintenance failure',()=>{
 it('keeps the successful task creation redirect and queue delivery',async()=>{
  const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  f.withDb.mockResolvedValueOnce(42).mockRejectedValueOnce(Object.assign(new Error('private db input'),{code:'42501'}));f.trySend.mockResolvedValue('sent');
  const form=new FormData();form.set('owner_text','Synthetic input');
  await createTaskAction(form);
  expect(f.requireOwner).toHaveBeenCalledOnce();expect(f.trySend).toHaveBeenCalledOnce();expect(f.redirect).toHaveBeenCalledExactlyOnceWith('/console?n=created-sent&task=42');
  expect(log).toHaveBeenCalledExactlyOnceWith('office drain failed (Error 42501)');
 });
 it('sends the orchestrator start message before the office drain starts',async()=>{
  vi.spyOn(console,'log').mockImplementation(()=>undefined);
  const order:string[]=[];
  f.withDb.mockImplementationOnce(async()=>{order.push('create');return 42;}).mockImplementationOnce(async()=>{order.push('drain');});
  f.trySend.mockImplementation(async()=>{order.push('send');return 'sent';});
  const form=new FormData();form.set('owner_text','Synthetic input');
  await createTaskAction(form);
  expect(order).toEqual(['create','send','drain']);
  expect(f.redirect).toHaveBeenCalledExactlyOnceWith('/console?n=created-sent&task=42');
 });
 it('still drains after a failed send without changing the failure notice, and skips it when no task was created',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  f.withDb.mockResolvedValueOnce(7).mockRejectedValueOnce(new Error('private db input'));
  f.trySend.mockRejectedValue(new Error('queue down'));
  const form=new FormData();form.set('owner_text','Synthetic input');
  await createTaskAction(form);
  expect(f.withDb).toHaveBeenCalledTimes(2);
  expect(f.redirect).toHaveBeenLastCalledWith('/console?n=db-error&task=7');
  f.withDb.mockReset();f.withDb.mockRejectedValueOnce(new Error('create failed'));
  await createTaskAction(form);
  expect(f.withDb).toHaveBeenCalledOnce();
  expect(f.redirect).toHaveBeenLastCalledWith('/console?n=db-error');
 });
 it('drains only after a successful agents_paused toggle',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  f.withDb.mockRejectedValueOnce(new Error('flag write failed'));
  const paused=new FormData();paused.set('key','agents_paused');paused.set('value','true');await setFlagAction(paused);
  expect(f.withDb).toHaveBeenCalledOnce();expect(f.redirect).toHaveBeenLastCalledWith('/console?n=db-error');
  f.withDb.mockReset();f.withDb.mockResolvedValueOnce(undefined);
  const pipelines=new FormData();pipelines.set('key','pipelines_paused');pipelines.set('value','true');await setFlagAction(pipelines);
  expect(f.withDb).toHaveBeenCalledOnce();expect(f.redirect).toHaveBeenLastCalledWith('/console?n=flag-updated');
 });
 it('keeps a successful pause toggle redirect',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  f.withDb.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('private db input'));
  const form=new FormData();form.set('key','agents_paused');form.set('value','true');await setFlagAction(form);
  expect(f.redirect).toHaveBeenCalledExactlyOnceWith('/console?n=flag-updated');expect(f.withDb).toHaveBeenCalledTimes(2);
 });
});
