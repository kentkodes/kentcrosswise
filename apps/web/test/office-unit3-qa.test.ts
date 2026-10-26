import { afterEach, describe, expect, it, vi } from "vitest";
const { withDb } = vi.hoisted(() => ({ withDb: vi.fn() }));
vi.mock("../src/server/db", () => ({ withDb }));
import type { Queryable } from "../src/server/db";
import { drainOffice, tryDrainOffice } from "../src/server/office-drain";

afterEach(() => { vi.restoreAllMocks(); withDb.mockReset(); });

describe("console office maintenance", () => {
  it("bounds batches at three and keeps the timeout local to its transaction", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ counts: { busy: false, processed: 50, dead: 0 } }] : [] }));
    await drainOffice({ query } as unknown as Queryable);
    expect(query.mock.calls.map((x) => x[0])).toEqual(["SET LOCAL statement_timeout = '5s'", "SELECT office_drain(50) AS counts", "SELECT office_drain(50) AS counts", "SELECT office_drain(50) AS counts"]);
  });
  it("returns successfully when the separate database transaction fails", async () => {
    withDb.mockRejectedValue(Object.assign(new Error("synthetic private input"), { code: "42501" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(tryDrainOffice()).resolves.toBeUndefined();
    expect(withDb).toHaveBeenCalledExactlyOnceWith("web_rw", drainOffice);
    expect(log).toHaveBeenCalledExactlyOnceWith("office drain failed (Error 42501)");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private input");
  });
  it("stops on a busy result and only logs dead row counts", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ counts: { busy: true, processed: 50, dead: 3 } }] : [] }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await drainOffice({ query } as unknown as Queryable);
    expect(query).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledExactlyOnceWith("office dead=3");
  });
});

describe("requested workflow capability boundary", () => {
  it("gates trusted_workflow starting while preserving legacy start reports", async () => {
    const { parseOfficeEnvelope } = await import("../src/office-contract");
    const { officeFixture } = await import("./fixtures/office-contract");
    const value = officeFixture();
    for (const execution of value.snapshot.executions!) {
      execution.phase = "unknown"; execution.outcome = null; execution.observation = null;
    }
    const start = value.snapshot.executions![3]!;
    start.phase = "starting";
    start.observation = { source: "trusted_workflow", observed_at: value.observed_at };
    value.capabilities.execution_observations = false;
    expect(parseOfficeEnvelope(value)).toEqual({ ok: false, code: "association" });
    value.capabilities.execution_observations = null;
    expect(parseOfficeEnvelope(value)).toEqual({ ok: false, code: "association" });
    value.capabilities.execution_observations = true;
    expect(parseOfficeEnvelope(value).ok).toBe(true);
    value.capabilities.execution_observations = false;
    start.observation.source = "trusted_start_report";
    expect(parseOfficeEnvelope(value).ok).toBe(true);
  });
});
