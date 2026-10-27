import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseOfficeEnvelope, type AvailableOffice } from "../src/office-contract";
import { runAs } from "../src/server/db";
import { loadOfficeProjection, readOfficeProjection, type OfficeRequest } from "../src/server/office-projection";
import { freshDb, pglitePool } from "./pglite";

// Regression tests for the unit-2 QA review (2026-10-26). Each case started as a QA probe; the
// former "QA-GAP" probes now assert the fixed behaviour. Every adapter response must still pass
// the unit-1 parser.

describe("office projection QA regressions", () => {
  let pg: PGlite;
  let n = 0;
  const project = async (transition: unknown, key = `qa-${++n}`) =>
    (await pg.query<{ r: number | null }>("SELECT office_project($1, $2::jsonb)::int AS r", [key, JSON.stringify(transition)])).rows[0]!.r;
  const read = async (request: OfficeRequest): Promise<AvailableOffice> => {
    const office = await runAs(pglitePool(pg), "web_public", (db) => readOfficeProjection(db, request), { readOnly: true });
    expect(parseOfficeEnvelope(office)).toEqual({ ok: true, value: office });
    return office;
  };
  const load = (request: OfficeRequest) =>
    loadOfficeProjection(request, (fn) => runAs(pglitePool(pg), "web_public", fn, { readOnly: true }));
  const taskRef = async (): Promise<string> => (await pg.query<{ ref: string }>("SELECT ref FROM v_office_tasks LIMIT 1")).rows[0]!.ref;

  beforeEach(async () => {
    pg = await freshDb();
  });
  afterEach(async () => {
    await pg.close();
  });

  it("a public retitle of an inactive task is delivered as a relabel with the task's current row", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "Fix login for ACME Corp", state: "done" }], events: [{ task_id: 1, role: "developer", type: "merged" }] });
    const before = await read({ mode: "bootstrap" });
    expect(JSON.stringify(before)).toContain("ACME");
    await project({ tasks: [{ task_id: 1, public_title: "Fix login" }] });
    const ref = await taskRef();
    const current = { ref, visibility: "public", description: "Fix login" };
    const stale = await read({ mode: "incremental", cursor: before.history.cursor! });
    expect(stale.history.gap).toMatchObject({ reason: "privacy_changed", recovery: "rebind" });
    expect(stale.history.invalidations).toEqual([{ task_ref: ref, kind: "relabel" }]);
    expect(stale.snapshot.tasks).toEqual([expect.objectContaining(current)]);
    const rebound = await read({ mode: "incremental", cursor: before.history.cursor!, rebind: true });
    expect(rebound.history.invalidations).toEqual([{ task_ref: ref, kind: "relabel" }]);
    expect(rebound.snapshot.tasks).toEqual([expect.objectContaining(current)]);
    expect(JSON.stringify([stale, rebound])).not.toContain("ACME");
    // A client already at the new epoch gets no invalidation.
    expect((await read({ mode: "incremental", cursor: rebound.history.cursor! })).history.invalidations).toEqual([]);
  });

  it("public T1 -> private -> public T2 still withdraws T1 for a client at the old epoch", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "Secret client name", state: "done" }], events: [{ task_id: 1, role: "developer", type: "merged" }] });
    const before = await read({ mode: "bootstrap" });
    await project({ tasks: [{ task_id: 1, is_private: true }] });
    const middle = await read({ mode: "bootstrap" });
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "Neutral title" }] });
    const ref = await taskRef();
    for (const cursor of [before.history.cursor!]) {
      const stale = await read({ mode: "incremental", cursor });
      expect(stale.history.gap?.reason).toBe("privacy_changed");
      // History holds a redact and a later republish: the kind follows current visibility.
      expect(stale.history.invalidations).toEqual([{ task_ref: ref, kind: "relabel" }]);
      expect(stale.snapshot.tasks).toEqual([expect.objectContaining({ ref, visibility: "public", description: "Neutral title" })]);
      expect(JSON.stringify(stale)).not.toContain("Secret client name");
    }
    // A client that already saw "Private task" (epoch after the redaction) needs no invalidation:
    // republishing withdraws nothing it holds, and the new title arrives with the task.
    const fresh = await read({ mode: "incremental", cursor: middle.history.cursor! });
    expect(fresh.history.gap).toBeNull();
    expect(fresh.history.invalidations).toEqual([]);
  });

  it("a stale state-mode refresh gets the same privacy_changed response with invalidations", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "Public title", state: "in_progress" }] });
    const before = await read({ mode: "state" });
    await project({ tasks: [{ task_id: 1, is_private: true }] });
    const ref = await taskRef();
    const stale = await read({ mode: "state", privacy_epoch: before.privacy_epoch });
    expect(stale.history).toMatchObject({
      mode: "state", completeness: "gap", gap: { reason: "privacy_changed", recovery: "rebind", from: null }, invalidations: [{ task_ref: ref, kind: "redact" }],
    });
    expect(stale.snapshot.tasks).toEqual([expect.objectContaining({ ref, visibility: "private", description: "Private task" })]);
    const current = await read({ mode: "state", privacy_epoch: stale.privacy_epoch });
    expect(current.history).toMatchObject({ gap: null, invalidations: [] });
    expect((await read({ mode: "state", privacy_epoch: "99" })).history.gap).toMatchObject({ reason: "cursor_unavailable", recovery: "restart" });
    for (const privacy_epoch of ["", "01", "-1", "1.5", "99999999999999999999"]) {
      await expect(load({ mode: "state", privacy_epoch })).rejects.toMatchObject({ code: "epoch" });
    }
  });

  it("a duplicate source key with different content is refused; identical redelivery is a no-op", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "queued" }] }, "agent_event:5");
    expect(await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "queued" }] }, "agent_event:5")).toBeNull();
    await expect(project({ tasks: [{ task_id: 1, state: "failed" }], events: [{ task_id: 1, role: "developer", type: "failed" }] }, "agent_event:5")).rejects.toThrow(
      /^office_project: source key was already projected with different content$/,
    );
    await expect(project({ tasks: [{ task_id: 1, state: "failed" }] }, "agent_event:5")).rejects.toMatchObject({ code: "P0K01" });
    const { rows } = await pg.query<{ state: string }>("SELECT state FROM v_office_tasks");
    expect(rows[0]!.state).toBe("queued");
  });

  it("-infinity and BC timestamps are refused at write, so reads stay available", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "queued" }], events: [{ task_id: 1, role: "developer", type: "coding" }] });
    for (const recorded_at of ["-infinity", "infinity", "2020-01-01T00:00:00Z BC", "0099-01-01T00:00:00Z"]) {
      await expect(project({ events: [{ task_id: 1, role: "developer", type: "coding", recorded_at }] })).rejects.toThrow(/^office_project: timestamp/);
    }
    const office = await load({ mode: "bootstrap" });
    expect(office.available).toBe(true);
    expect(office.history!.replay!.events).toHaveLength(1);
  });

  it("more than 256 pending invalidations get an explicit restart, not an unavailable envelope", async () => {
    const tasks = Array.from({ length: 257 }, (_, i) => ({ task_id: i + 1, is_private: false, public_title: `T${i}`, state: "done" }));
    await project({ tasks });
    const before = await read({ mode: "bootstrap" });
    await project({ tasks: tasks.map((t) => ({ task_id: t.task_id, is_private: true })) });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stale = await load({ mode: "incremental", cursor: before.history.cursor! });
    const rebound = await load({ mode: "incremental", cursor: before.history.cursor!, rebind: true });
    const state = await load({ mode: "state", privacy_epoch: before.privacy_epoch });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    for (const office of [stale, rebound, state]) {
      expect(office.available).toBe(true);
      expect(office.history).toMatchObject({ completeness: "gap", gap: { reason: "privacy_changed", recovery: "restart" }, invalidations: [] });
    }
    // Exactly 256 still fits and is delivered.
    await project({ tasks: tasks.slice(0, 256).map((t) => ({ task_id: t.task_id, is_private: false })) });
    const at256 = await read({ mode: "bootstrap" });
    await project({ tasks: tasks.slice(0, 256).map((t) => ({ task_id: t.task_id, public_title: `Renamed ${t.task_id}` })) });
    expect((await read({ mode: "state", privacy_epoch: at256.privacy_epoch })).history.invalidations).toHaveLength(256);
  });

  it("error text for a malformed timestamp does not include the input value", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A" }] });
    for (const recorded_at of ["Private Title Here", "2026-13-45T00:00:00Z", "2026-01-01T00:00:00Z Private Title Here"]) {
      const error = await project({ events: [{ task_id: 1, role: "developer", type: "coding", recorded_at }] }).then(() => null, (e: Error & { detail?: string }) => e);
      expect(error?.message).toMatch(/^office_project: /);
      expect(`${error?.message} ${error?.detail ?? ""}`).not.toContain("Private Title Here");
      expect(`${error?.message} ${error?.detail ?? ""}`).not.toContain("2026-13-45");
    }
  });

  it("pause-only revision gives watermark (R,0) with no event there; paging still works", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "queued" }], events: [{ task_id: 1, role: "developer", type: "coding" }, { task_id: 1, role: "developer", type: "coding" }] });
    const b = await read({ mode: "bootstrap" });
    await project({ pause: { paused: true } });
    await project({ events: [{ task_id: 1, role: "qa", type: "qa_reviewing" }] });
    const page = await load({ mode: "incremental", cursor: b.history.cursor! });
    expect(page.available).toBe(true);
    expect(page.events.map((e) => e.position)).toEqual([{ revision: "3", ordinal: 0 }]);
  });

  it("parent cycles are refused by the writer", async () => {
    await project({ tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "queued" }, { task_id: 2, is_private: false, public_title: "B", state: "queued" }] });
    await expect(project({ tasks: [{ task_id: 1, parent_task_id: 2, parent_kind: "planner_parent" }, { task_id: 2, parent_task_id: 1, parent_kind: "planner_parent" }] })).rejects.toThrow(/cycle/);
    expect((await load({ mode: "state" })).snapshot?.related_tasks).toEqual([]);
  });

  it("a terminal execution cannot be revived to starting by a later transition", async () => {
    await project({ capabilities: { execution_observations: true }, tasks: [{ task_id: 1, is_private: false, public_title: "A", state: "in_progress", role: "developer" }],
      executions: [{ key: "x", task_id: 1, role: "developer", phase: "terminal", outcome: "failed", observation_source: "trusted_workflow", observed_at: "2026-10-25T00:00:00Z" }] });
    await expect(project({ executions: [{ key: "x", phase: "starting", outcome: null, observation_source: "trusted_start_report", observed_at: "2026-10-25T00:00:01Z" }] })).rejects.toThrow(
      /terminal execution cannot change phase or outcome/,
    );
    const { rows } = await pg.query<{ phase: string }>("SELECT phase FROM v_office_executions");
    expect(rows[0]!.phase).toBe("terminal");
  });

  // Owner-level open question held by the Liaison: unchanged behaviour, recorded here.
  it("private child of a public parent shows the parent's public title in related_tasks (held question)", async () => {
    await project({ tasks: [
      { task_id: 1, is_private: false, public_title: "Public parent", kind: "work", state: "merged" },
      { task_id: 2, is_private: true, kind: "docs", state: "queued", parent_task_id: 1, parent_kind: "docs_parent" },
    ] });
    const office = await load({ mode: "state" });
    expect(office.snapshot?.related_tasks).toEqual([expect.objectContaining({ visibility: "public", description: "Public parent" })]);
  });
});
