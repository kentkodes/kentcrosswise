// Opt in only against a disposable, local PostgreSQL server. No dependency or CI service added.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fromPg, migrate } from "../src/index";
const url=process.env.KCW_REAL_PG_URL;
describe.skipIf(!url)("real Postgres office races",()=>{
 let admin:pg.Client;let a:pg.Client;let b:pg.Client;let c:pg.Client;let name:string;
 beforeAll(async()=>{
  const target=new URL(url!);
  if(!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw Error('real PG test requires localhost');
  admin=new pg.Client({connectionString:url});await admin.connect();
  name=`kcw_office_${process.pid}_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${name}`);target.pathname='/'+name;
  a=new pg.Client({connectionString:target.toString()});b=new pg.Client({connectionString:target.toString()});c=new pg.Client({connectionString:target.toString()});
  await Promise.all([a.connect(),b.connect(),c.connect()]);await migrate(fromPg(c));
  await c.query('SELECT office_drain(50)');
 },30000);
 afterAll(async()=>{
  await Promise.allSettled([a?.end(),b?.end(),c?.end()]);
  if(admin){if(name)await admin.query(`DROP DATABASE ${name}`);await admin.end();}
 });
 const task=async(client:pg.Client)=> Number((await client.query("INSERT INTO tasks(source,owner_text,agent) VALUES('console','synthetic','developer') RETURNING id")).rows[0].id);
 const drain=async(client:pg.Client)=>(await client.query('SELECT office_drain(50) r')).rows[0].r;
 const finalDrain=async()=>{while((await drain(c)).processed===50){ /* bounded batches until empty */ }};
 it('does not miss a lower id that commits late',async()=>{
  await a.query('BEGIN');const first=await task(a);const second=await task(b);
  expect((await drain(c)).projected).toBe(1);
  await a.query('COMMIT');expect((await drain(c)).projected).toBe(1);
  expect((await c.query("SELECT status FROM office_outbox WHERE source_table='tasks' AND source_key=ANY($1)",[[String(first),String(second)]])).rows).toEqual([{status:'projected'},{status:'projected'}]);
 });
 it('returns busy immediately for the second projector and lets writers commit independently',async()=>{
  await task(c);await a.query('BEGIN');await drain(a);
  await b.query("SET statement_timeout='1s'");expect((await drain(b)).busy).toBe(true);
  await b.query('BEGIN');await b.query("SET LOCAL lock_timeout='1s'");const id=await task(b);
  await b.query("UPDATE tasks SET status='planning' WHERE id=$1",[id]);
  await b.query("INSERT INTO agent_events(task_id,agent,event_type) VALUES($1,'developer','coding')",[id]);
  await b.query("UPDATE system_flags SET value='true',updated_at=now() WHERE key='agents_paused'");
  await b.query('COMMIT');await a.query('COMMIT');await finalDrain();
  expect((await c.query("SELECT count(*)::int n FROM office_outbox WHERE status='pending'")).rows[0].n).toBe(0);
 });
 it('supersedes an older queued version after a newer version projects',async()=>{
  const id=await task(c);await finalDrain();
  await c.query("UPDATE tasks SET status='planning' WHERE id=$1",[id]);
  const low=(await c.query("SELECT max(id) id FROM office_outbox")).rows[0].id;
  await c.query("UPDATE office_outbox SET next_attempt_at=now()+interval '1 hour' WHERE id=$1",[low]);
  await c.query("UPDATE tasks SET status='waiting',waiting_on='dev' WHERE id=$1",[id]);await finalDrain();
  await c.query("UPDATE office_outbox SET next_attempt_at=now() WHERE id=$1",[low]);await finalDrain();
  expect((await c.query('SELECT status FROM office_outbox WHERE id=$1',[low])).rows[0].status).toBe('superseded');
 });
 it('handles 1000 deterministic randomized writer/projector interleavings exactly once',async()=>{
  let random=20261026;
  for(let i=0;i<1000;i++){
   random=(Math.imul(random,1664525)+1013904223)>>>0;
   await a.query('BEGIN');await task(a);await task(b);
   if(random&1)await drain(c);
   await a.query('COMMIT');
   await a.query('BEGIN');await drain(a);
   expect((await drain(b)).busy).toBe(true);
   await a.query('COMMIT');
  }
  await finalDrain();
  expect((await c.query("SELECT count(*)::int n FROM office_outbox WHERE status IN ('pending','dead')")).rows[0].n).toBe(0);
  const revisions=(await c.query('SELECT revision::int r FROM office_source_deliveries ORDER BY revision')).rows.map(v=>v.r);
  expect(revisions).toEqual(Array.from({length:revisions.length},(_,i)=>i+1));
  expect((await c.query('SELECT count(*)::int n FROM office_journal j WHERE ordinal<>(SELECT count(*)-1 FROM office_journal k WHERE k.revision=j.revision AND k.ordinal<=j.ordinal)')).rows[0].n).toBe(0);
 },120000);
});
