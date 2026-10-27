import type pg from "pg";
import type { TaskInput, TaskStore } from "../src/graph";
import { describe, expect, it, vi } from "vitest";
import type { OfficeQuery } from "../src/office";
import { drainOffice, drainOfficeConnection, drainOfficePool, officeError } from "../src/office";

describe("office drain best-effort boundaries", () => {
  it("bounds full-batch work at three calls and stops immediately when busy", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ counts: { processed: 50, busy: false, dead: 0 } }] });
    await drainOffice({ query } as unknown as OfficeQuery, vi.fn());
    expect(query).toHaveBeenCalledTimes(3);
    query.mockClear().mockResolvedValue({ rows: [{ counts: { processed: 0, busy: true, dead: 2 } }] });
    const log = vi.fn();
    await drainOffice({ query } as unknown as OfficeQuery, log);
    expect(query).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith("office dead=2");
  });

  it("rolls back a failed pooled drain and releases a healthy connection", async () => {
    const error = Object.assign(new Error("synthetic database private input"), { code: "22023" });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT")) throw error;
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) };
    const log = vi.fn();
    await expect(drainOfficePool(pool as unknown as pg.Pool, log)).resolves.toBeUndefined();
    expect(query.mock.calls.map((x) => x[0])).toEqual(["BEGIN", "SET LOCAL statement_timeout = '5s'", "SELECT office_drain(50) AS counts", "ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(log).toHaveBeenCalledExactlyOnceWith("office drain failed (Error 22023)");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private input");
  });

  it("discards a pooled connection when rollback fails", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT") || sql === "ROLLBACK") throw Error("synthetic failure");
      return { rows: [] };
    });
    const release = vi.fn();
    await expect(drainOfficePool({ connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as pg.Pool, vi.fn())).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("commits a successful direct connection drain and uses a local timeout", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.startsWith("SELECT") ? [{ counts: { busy: false, processed: 0, dead: 0 } }] : [] }));
    await drainOfficeConnection({ query } as unknown as OfficeQuery, vi.fn());
    expect(query.mock.calls.map((x) => x[0])).toEqual(["BEGIN", "SET LOCAL statement_timeout = '5s'", "SELECT office_drain(50) AS counts", "COMMIT"]);
  });

  it("swallows direct connection failures and rejects arbitrary error labels", async () => {
    const error = Object.assign(new Error("synthetic private input"), { name: "Contains private input", code: "unbounded private input" });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT")) throw error;
      return { rows: [] };
    });
    const log = vi.fn();
    await expect(drainOfficeConnection({ query } as unknown as OfficeQuery, log)).resolves.toBeUndefined();
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(log).toHaveBeenCalledExactlyOnceWith("office drain failed (Error)");
    expect(officeError(error)).toBe("office drain failed (Error)");
  });
});

describe("checkpointed office observation failures", () => {
  it("recovers a failed observation on redelivery before deduplicating it", async () => {
    const { MemorySaver } = await import("@langchain/langgraph");
    const { buildTaskGraph, initialTaskData, processTaskInput } = await import("../src/graph");
    const { FakeGitHubClient } = await import("../src/github");
    const { threadConfig } = await import("../src/handler");
    const recordRun = vi.fn().mockResolvedValue(undefined);
    const store = { recordRun } as unknown as TaskStore;
    const deps = { store, github: new FakeGitHubClient(), planner: { split: async () => [], plan: async () => ({ title: "Synthetic", body: "Synthetic" }) } };
    const saver = new MemorySaver();
    const graph = buildTaskGraph(saver, deps);
    const observation = (messageId: string, runId: number): TaskInput => ({
      kind: "github", event: "workflow_run", action: "completed", run_id: runId,
      run_attempt: 1, agent_task_id: 1, head_branch: "main", trigger: "workflow_dispatch",
      workflow_path: ".github/workflows/agent-developer.yml", head_sha: null,
      pr_numbers: [], conclusion: "success", message_id: messageId,
    });
    await graph.invoke({ task_id: 1, input: observation("seed", 100), task: { ...initialTaskData(), phase: "done" } }, threadConfig(1));
    recordRun.mockClear().mockRejectedValueOnce(Error("synthetic database failure")).mockResolvedValue(undefined);
    const late = observation("retry", 101);
    await expect(processTaskInput(graph, 1, late)).rejects.toThrow("synthetic database failure");
    const freshGraph = buildTaskGraph(saver, deps);
    expect(await processTaskInput(freshGraph, 1, late)).toBe("recovered");
    expect(await processTaskInput(freshGraph, 1, late)).toBe("duplicate");
    expect(recordRun).toHaveBeenCalledTimes(2);
    expect((await freshGraph.getState(threadConfig(1))).next).toEqual([]);
  });
});
