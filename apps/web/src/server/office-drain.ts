// withDb owns this separate transaction; a failure rolls back without changing the owner action.
import { withDb, type Queryable } from "./db";
export async function drainOffice(db: Queryable): Promise<void> {
 await db.query("SET LOCAL statement_timeout = '5s'");
 for(let i=0;i<3;i++) {
  const {rows}=await db.query<{counts:{busy:boolean;processed:number;dead:number}}>("SELECT office_drain(50) AS counts");
  const counts=rows[0]?.counts;
  if(counts?.dead) console.log(`office dead=${counts.dead}`);
  if(!counts || counts.busy || counts.processed<50) break;
 }
}
export async function tryDrainOffice(): Promise<void> {
 try { await withDb("web_rw",drainOffice); }
 catch(error) {
  const code=typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  console.error(`office drain failed (${error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : "Error"}${/^[A-Z0-9]{5}$/.test(code) ? ` ${code}` : ""})`);
 }
}
