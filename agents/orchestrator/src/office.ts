// Best effort, bounded projection maintenance on a dedicated connection/transaction.
import type pg from "pg";
export interface OfficeCounts { busy: boolean; processed: number; dead: number }
export interface OfficeQuery { query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }> }
export function officeError(error: unknown): string {
 const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
 return `office drain failed (${error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,60}$/.test(error.name) ? error.name : "Error"}${/^[A-Z0-9]{5}$/.test(code) ? ` ${code}` : ""})`;
}
export async function drainOffice(db: OfficeQuery, log: (line: string) => void): Promise<void> {
 for (let i = 0; i < 3; i++) {
  const { rows } = await db.query<{counts: OfficeCounts}>("SELECT office_drain(50) AS counts");
  const counts = rows[0]?.counts;
  if (counts?.dead) log(`office dead=${counts.dead}`);
  if (!counts || counts.busy || counts.processed < 50) break;
 }
}
export async function drainOfficePool(pool: pg.Pool, log: (line: string) => void): Promise<void> {
 let client: pg.PoolClient | undefined; let broken = false;
 try {
  client = await pool.connect();
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '5s'");
  await drainOffice(client, log);
  await client.query("COMMIT");
 } catch (error) {
  if (client) await client.query("ROLLBACK").catch(() => { broken = true; });
  log(officeError(error));
 } finally { client?.release(broken); }
}
export async function drainOfficeConnection(db: OfficeQuery, log: (line: string) => void): Promise<void> {
 try {
  await db.query("BEGIN");
  await db.query("SET LOCAL statement_timeout = '5s'");
  await drainOffice(db, log);
  await db.query("COMMIT");
 } catch (error) {
  await db.query("ROLLBACK").catch(() => undefined);
  log(officeError(error));
 }
}
