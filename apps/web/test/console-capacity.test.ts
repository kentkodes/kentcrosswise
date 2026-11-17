import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { capacitySummary, listTasks } from "../src/server/console";
import { runAs, type Queryable } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

// AR6 owner capacity (console line and rows). Synthetic tasks only; no live calls.
describe("owner capacity as web_rw (PGlite)", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.query("DELETE FROM tasks");
  });

  /** One leaf task: status, waiting_on and execution_wait as given. Returns its id. */
  async function task(
    status: string,
    waitingOn: string | null = null,
    executionWait: string | null = null,
    extra: { parentId?: number; source?: string } = {},
  ): Promise<number> {
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO tasks (source, owner_text, status, waiting_on, execution_wait, parent_id)
       VALUES ($1, 'synthetic owner text', $2, $3, $4, $5) RETURNING id`,
      [extra.source ?? "console", status, waitingOn, executionWait, extra.parentId ?? null],
    );
    return Number(rows[0]!.id);
  }

  it("four tasks waiting on the owner and one queued: four parked, no active workers", async () => {
    for (let i = 0; i < 4; i++) await task("waiting", "owner");
    await task("queued");
    expect(await asRw(capacitySummary)).toEqual({
      active: 0,
      admitted: 4,
      parked: { owner: 4, ci: 0, worker: 0, other: 0 },
      queued: 1,
    });
  });

  it("splits a mixed set into active, parked CI, and waiting for a worker", async () => {
    const parent = await task("merged");
    await task("waiting", "dev");
    await task("waiting", "qa");
    await task("waiting", "dev", null, { parentId: parent, source: "github" });
    await task("waiting", "ci");
    await task("planning", null, "developer");
    expect(await asRw(capacitySummary)).toEqual({
      active: 3,
      admitted: 5,
      parked: { owner: 0, ci: 1, worker: 1, other: 0 },
      queued: 0,
    });
  });

  it("counts planning, and waiting without a waiting_on, as other parked work", async () => {
    await task("planning");
    await task("waiting", "deploy");
    expect(await asRw(capacitySummary)).toEqual({
      active: 0,
      admitted: 2,
      parked: { owner: 0, ci: 0, worker: 0, other: 2 },
      queued: 0,
    });
  });

  it("does not count a parent with children; its children are counted", async () => {
    const parent = await task("waiting", "dev");
    await task("planning", null, null, { parentId: parent });
    await task("waiting", "qa", null, { parentId: parent });
    await task("queued", null, null, { parentId: parent });
    expect(await asRw(capacitySummary)).toEqual({
      active: 1,
      admitted: 2,
      parked: { owner: 0, ci: 0, worker: 0, other: 1 },
      queued: 1,
    });
  });

  it("an empty board is all zeros", async () => {
    expect(await asRw(capacitySummary)).toEqual({
      active: 0,
      admitted: 0,
      parked: { owner: 0, ci: 0, worker: 0, other: 0 },
      queued: 0,
    });
  });

  it("listTasks returns the execution_wait reason of each row", async () => {
    const waiting = await task("planning", null, "qa");
    const plain = await task("waiting", "owner");
    const rows = await asRw((db) => listTasks(db));
    expect(rows.find((r) => r.id === waiting)?.executionWait).toBe("qa");
    expect(rows.find((r) => r.id === plain)?.executionWait).toBeNull();
  });
});
