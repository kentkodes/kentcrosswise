// The local e2e wire server (e2e/support/pg-socket.ts) must keep one connection's transaction
// intact while other pool connections are used on the same PGlite session.
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { servePglite, type PgSocketServer } from "../e2e/support/pg-socket";

/** True if `p` has not settled after `ms`. */
async function isPending(p: Promise<unknown>, ms = 150): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !settled;
}

describe("servePglite: one transaction owns the shared session", () => {
  let pgl: PGlite;
  let server: PgSocketServer;
  let clients: pg.Client[];

  beforeEach(async () => {
    pgl = new PGlite();
    await pgl.exec("CREATE TABLE t (v int); CREATE ROLE restricted NOLOGIN; GRANT SELECT ON t TO restricted;");
    server = await servePglite(pgl);
    clients = [];
  });

  afterEach(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    await server.close();
    await pgl.close();
  });

  async function connect(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: server.url });
    clients.push(client);
    await client.connect();
    return client;
  }

  it("keeps SET LOCAL ROLE from leaking into another connection", async () => {
    const a = await connect();
    const b = await connect();
    const base = (await b.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u;

    await a.query("BEGIN");
    await a.query("SET LOCAL ROLE restricted");
    const seen = b.query<{ u: string }>("SELECT current_user AS u");
    expect(await isPending(seen)).toBe(true);

    expect((await a.query<{ u: string }>("SELECT current_user AS u")).rows[0]?.u).toBe("restricted");
    await a.query("COMMIT");

    expect((await seen).rows[0]?.u).toBe(base);
  });

  it("does not fail another connection when one transaction errors", async () => {
    const a = await connect();
    const b = await connect();

    await a.query("BEGIN");
    await expect(a.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
    const seen = b.query<{ one: number }>("SELECT 1 AS one");
    expect(await isPending(seen)).toBe(true);

    await a.query("ROLLBACK");
    expect((await seen).rows[0]?.one).toBe(1);
  });

  it("rolls back a transaction left open by a closed connection", async () => {
    const a = await connect();
    const b = await connect();

    await a.query("BEGIN");
    await a.query("INSERT INTO t VALUES (1)");
    const seen = b.query<{ n: number }>("SELECT count(*)::int AS n FROM t");
    expect(await isPending(seen)).toBe(true);

    await a.end();
    expect((await seen).rows[0]?.n).toBe(0);
  });
});
