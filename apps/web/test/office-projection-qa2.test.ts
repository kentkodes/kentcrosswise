import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOfficeEnvelope, type AvailableOffice } from "../src/office-contract";
import { runAs } from "../src/server/db";
import { readOfficeProjection, type OfficeRequest } from "../src/server/office-projection";
import { freshDb, pglitePool } from "./pglite";

// QA re-review probes (2026-10-26, second pass). Created by QA; updated to assert the fixed
// behaviour (custom dedupe SQLSTATE, redact/relabel split).
describe("office projection QA re-review probes", () => {
  let pg: PGlite;
  let n = 0;
  const project = async (transition: unknown, key = `qa2-${++n}`) =>
    (await pg.query<{ r: number | null }>("SELECT office_project($1, $2::jsonb)::int AS r", [key, JSON.stringify(transition)])).rows[0]!.r;
  const read = (request: OfficeRequest): Promise<AvailableOffice> =>
    runAs(pglitePool(pg), "web_public", (db) => readOfficeProjection(db, request), { readOnly: true });

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("catch-all keeps the state-row lock on success and leaves no residue on failure", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "queued" }] });
    await pg.exec("BEGIN");
    await project({});
    const { rows } = await pg.query<{ mode: string }>(
      "SELECT mode FROM pg_locks WHERE pid = pg_backend_pid() AND relation = 'office_projection_state'::regclass AND granted",
    );
    await pg.exec("ROLLBACK");
    expect(rows.map((r) => r.mode)).toContain("RowShareLock");
    const before = (await pg.query<{ r: string }>("SELECT revision::text AS r FROM office_projection_state")).rows[0]!.r;
    await expect(project({ executions: [{ key: "k", task_id: 1, role: "qa", station: "developer" }] })).rejects.toThrow(/^office_project: rejected \(23514\)$/);
    expect((await pg.query<{ r: string }>("SELECT revision::text AS r FROM office_projection_state")).rows[0]!.r).toBe(before);
    expect((await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM office_refs WHERE kind = 'execution'")).rows[0]!.n).toBe(0);
  });

  it("dedupe: key order does not matter; mismatch uses the custom SQLSTATE P0K01, not 23505", async () => {
    await pg.query("SELECT office_project('dup', $1::jsonb)", ['{"pause":{"paused":true},"capabilities":{"routing_events":true}}']);
    const again = await pg.query<{ r: number | null }>("SELECT office_project('dup', $1::jsonb) AS r", ['{"capabilities":{"routing_events":true},"pause":{"paused":true}}']);
    expect(again.rows[0]!.r).toBeNull();
    const err = await pg.query("SELECT office_project('dup', '{}'::jsonb)").then(() => null, (e: { code?: string }) => e);
    expect(err?.code).toBe("P0K01");
  });

  it("a retitle is delivered as relabel; a forged redact with a public old-title row fails privacy", async () => {
    await project({ tasks: [{ task_id: 2, is_private: false, public_title: "Old title", state: "done" }], events: [{ task_id: 2, role: "developer", type: "merged" }] });
    const before = await read({ mode: "bootstrap" });
    await project({ tasks: [{ task_id: 2, public_title: "New title" }] });
    const stale = await read({ mode: "state", privacy_epoch: before.privacy_epoch });
    expect(parseOfficeEnvelope(stale).ok).toBe(true);
    expect(stale.history.invalidations).toEqual([{ task_ref: expect.any(String), kind: "relabel" }]);
    // Forge the server bug "made private but the row still shows the old public title":
    const ref = stale.history.invalidations[0]!.task_ref;
    const forged = structuredClone(stale);
    forged.history.invalidations = [{ task_ref: ref, kind: "redact" }];
    forged.snapshot.tasks = forged.snapshot.tasks!.map((t) => (t.ref === ref ? { ...t, visibility: "public" as const, description: "Old title" } : t));
    expect(parseOfficeEnvelope(forged)).toEqual({ ok: false, code: "privacy" });
  });

  it("timestamp helper rejects over-precise, infinite and spaced forms with fixed text", async () => {
    for (const recorded_at of ["2026-10-25T00:00:00.1234567Z", "infinity", "2026-10-25 00:00:00Z", "2026-10-25T00:00:00"]) {
      await expect(project({ events: [{ task_id: 1, role: "developer", type: "coding", recorded_at }] })).rejects.toThrow(/^office_project: timestamps must be ISO-8601 with a zone$/);
    }
  });
});
