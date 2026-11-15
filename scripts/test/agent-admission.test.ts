import { describe, expect, it, vi } from "vitest";
import { admission, admit, fence, listDispatchRuns, parseOp, runTitle, superseded } from "../lib/agent-admission";

const runs = (...rows: [number, string][]) => rows.map(([id, title]) => ({ id, title }));
const id = { agent: "developer", workflow: "agent-developer.yml", taskId: 5, op: 3, runId: 200 } as const;
/** A fake Actions API: `pages` are served in order, newest first like GitHub. */
const api = (...pages: [number, string][][]) => {
  const fetchMock = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json({ workflow_runs: (pages[page - 1] ?? []).map(([i, t]) => ({ id: i, display_title: t })) });
  });
  return { repo: "owner/repo", token: "synthetic", fetch: fetchMock as unknown as typeof fetch };
};

describe("parseOp", () => {
  it("accepts a decimal of up to 9 digits, including the first dispatch 0", () => {
    expect(parseOp("0")).toBe(0);
    expect(parseOp(" 12 ")).toBe(12);
    expect(parseOp("999999999")).toBe(999999999);
  });
  it.each([undefined, "", "01", "-1", "1.5", "1234567890", "x", "1 2"])("rejects %j without echoing it", (v) => {
    expect(() => parseOp(v)).toThrow(/^op must be/);
  });
});

describe("admission", () => {
  const title = runTitle("developer", 5, 3);
  it("admits the lowest run id of the exact title only", () => {
    const list = runs([100, title], [200, title], [50, runTitle("developer", 5, 2)], [10, "developer task 5"]);
    expect(admission(list, title, 100)).toEqual({ admitted: true, first: 100 });
    expect(admission(list, title, 200)).toEqual({ admitted: false, first: 100 });
  });
  it("admits a run that the listing does not show yet", () => {
    expect(admission([], title, 7)).toEqual({ admitted: true, first: 7 });
  });
  it("does not match other tasks, roles or op prefixes", () => {
    const list = runs([1, "developer task 55 op 3"], [2, "qa task 5 op 3"], [3, "developer task 5 op 30"]);
    expect(admission(list, title, 9).admitted).toBe(true);
  });
});

describe("superseded", () => {
  it("is true only for a higher op of the same agent and task", () => {
    expect(superseded(runs([1, "developer task 5 op 4"]), "developer", 5, 3)).toBe(true);
    expect(superseded(runs([1, "developer task 5 op 12"]), "developer", 5, 3)).toBe(true);
    expect(superseded(runs([1, "developer task 5 op 3"], [2, "developer task 5 op 2"]), "developer", 5, 3)).toBe(false);
    expect(superseded(runs([1, "developer task 6 op 9"], [2, "qa task 5 op 9"], [3, "developer task 5"], [4, "developer task 55 op 9"]), "developer", 5, 3)).toBe(false);
  });
});

describe("listDispatchRuns, admit and fence", () => {
  it("lists workflow_dispatch runs of main for the workflow, paging until a short page", async () => {
    const full: [number, string][] = Array.from({ length: 100 }, (_, i) => [1000 - i, "other"]);
    const gh = api(full, [[5, "developer task 5 op 3"]]);
    const list = await listDispatchRuns(gh, "agent-developer.yml");
    expect(list).toHaveLength(101);
    const urls = (gh.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/actions/workflows/agent-developer.yml/runs?event=workflow_dispatch&branch=main&per_page=100&page=1");
  });
  it("stops after 5 pages", async () => {
    const full: [number, string][] = Array.from({ length: 100 }, (_, i) => [i + 1, "other"]);
    const gh = api(full, full, full, full, full, full);
    await listDispatchRuns(gh, "agent-qa.yml");
    expect(gh.fetch).toHaveBeenCalledTimes(5);
  });
  it("admit: a later duplicate of the same operation is not admitted", async () => {
    const t = runTitle("developer", 5, 3);
    expect(await admit(api([[200, t], [100, t]]), id)).toEqual({ admitted: false, first: 100 });
    expect(await admit(api([[200, t]]), id)).toEqual({ admitted: true, first: 200 });
  });
  it("fence: not admitted, superseded or clear", async () => {
    const t = runTitle("developer", 5, 3);
    expect(await fence(api([[200, t], [100, t]]), id)).toBe("not_admitted");
    expect(await fence(api([[300, "developer task 5 op 4"], [200, t]]), id)).toBe("superseded");
    expect(await fence(api([[200, t], [150, "developer task 5 op 2"]]), id)).toBeNull();
  });
  it("a failed listing is an error, not an admission", async () => {
    const gh = { repo: "owner/repo", token: "synthetic", fetch: (async () => new Response("x", { status: 403 })) as unknown as typeof fetch };
    await expect(admit(gh, id)).rejects.toThrow(/403/);
  });
});
