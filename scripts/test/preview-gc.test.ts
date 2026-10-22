import { describe, expect, it } from "vitest";
import {
  deleteNeonPreviewBranch,
  findCandidates,
  gcOutputs,
  gcReport,
  githubPrState,
  type GcSources,
  type PrState,
} from "../lib/preview-gc";

const NOW = new Date("2026-10-22T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function sources(s: {
  objects?: { key: string; lastModified?: Date }[];
  branches?: { id: string; name: string; createdAt?: Date }[];
  params?: string[];
  tagged?: string[];
  prs?: Record<number, PrState>;
}): GcSources & { prCalls: number[] } {
  const src = {
    prCalls: [] as number[],
    stateObjects: async () => s.objects ?? [],
    neonBranches: async () => s.branches ?? [],
    parameterNames: async () => s.params ?? [],
    taggedPrs: async () => s.tagged ?? [],
    prState: async (pr: number) => {
      src.prCalls.push(pr);
      return s.prs?.[pr] ?? "missing";
    },
  };
  return src;
}

describe("findCandidates", () => {
  const world = sources({
    objects: [
      { key: "preview/pr-5.tfstate", lastModified: hoursAgo(1) },
      { key: "preview/pr-6.tfstate", lastModified: hoursAgo(30) },
      { key: "preview/pr-7.tfstate", lastModified: hoursAgo(1) },
      { key: "preview/pr-7.tfstate.tflock", lastModified: hoursAgo(1) },
      { key: "preview/notes.txt" },
      { key: "prod.tfstate" },
    ],
    branches: [
      { id: "br-base", name: "base" },
      { id: "br-8", name: "preview/pr-8", createdAt: hoursAgo(2) },
      { id: "br-0", name: "preview/pr-0", createdAt: hoursAgo(25) },
    ],
    params: ["/kcw/preview/pr-9/database-url", "/kcw/preview/pr-5/origin-verify"],
    tagged: ["10", "not-a-number"],
    prs: { 5: "open", 6: "open", 7: "closed", 8: "open", 9: "closed", 10: "open" },
  });

  it("groups leftovers per PR and applies the closed / 24 h rules", async () => {
    const c = await findCandidates(world, { now: NOW, maxAgeHours: 24 });
    const brief = c.map((x) => [x.pr, x.eligible, x.hasState, x.hasLock, x.hasBranch, x.hasOther]);
    expect(brief).toEqual([
      [0, true, false, false, true, false], // manual pr-0, no such PR, 25 h old
      [5, false, true, false, false, true], // open, fresh
      [6, true, true, false, false, false], // open but 30 h old
      [7, true, true, true, false, false], // closed
      [8, false, false, false, true, false], // open, fresh branch
      [9, true, false, false, false, true], // closed, parameter only
      [10, false, false, false, false, true], // open, untimed: left alone
    ]);
    expect(c.find((x) => x.pr === 10)?.reason).toMatch(/left alone/);
  });

  it("restricts to one PR and can force it", async () => {
    const one = await findCandidates(world, { now: NOW, maxAgeHours: 24, pr: 5 });
    expect(one.map((x) => [x.pr, x.eligible])).toEqual([[5, false]]);
    const src = sources({ objects: [{ key: "preview/pr-5.tfstate", lastModified: hoursAgo(0.1) }] });
    const forced = await findCandidates(src, { now: NOW, maxAgeHours: 24, pr: 5, force: true });
    expect(forced.map((x) => [x.pr, x.eligible])).toEqual([[5, true]]);
    expect(src.prCalls).toEqual([]);
  });

  it("returns nothing for a clean account", async () => {
    const c = await findCandidates(sources({ objects: [{ key: "prod.tfstate" }], branches: [{ id: "b", name: "base" }] }), {
      now: NOW,
      maxAgeHours: 24,
    });
    expect(c).toEqual([]);
    expect(gcOutputs(c)).toEqual({ prs: "[]", destroy_prs: "[]", lock_prs: "[]", count: "0", has_state: "false", has_branch: "false" });
    expect(gcReport(c)).toBe("No preview leftovers.\n");
  });
});

describe("gcOutputs and gcReport", () => {
  it("lists eligible PRs and those that need terraform destroy", async () => {
    const c = await findCandidates(
      sources({
        objects: [
          { key: "preview/pr-3.tfstate", lastModified: hoursAgo(1) },
          { key: "preview/pr-3.tfstate.tflock", lastModified: hoursAgo(1) },
        ],
        branches: [{ id: "b4", name: "preview/pr-4", createdAt: hoursAgo(1) }],
        prs: { 3: "closed", 4: "closed" },
      }),
      { now: NOW, maxAgeHours: 24 },
    );
    expect(gcOutputs(c)).toEqual({ prs: "[3,4]", destroy_prs: "[3]", lock_prs: "[3]", count: "2", has_state: "true", has_branch: "true" });
    expect(gcReport(c)).toContain("| pr-3 | state, lock | PR closed | clean |");
  });
});

describe("Neon branch deletion", () => {
  function neonFetch(branches: { id: string; name: string }[], deleteStatus = 200) {
    const calls: string[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "DELETE") return new Response("{}", { status: deleteStatus });
      return new Response(JSON.stringify({ branches }), { status: 200 });
    }) as typeof fetch;
    return { f, calls };
  }

  it("deletes the branch by id when it exists", async () => {
    const { f, calls } = neonFetch([{ id: "br-base", name: "base" }, { id: "br-x", name: "preview/pr-12" }]);
    expect(await deleteNeonPreviewBranch({ projectId: "proj", apiKey: "synthetic", fetch: f }, 12)).toBe(true);
    expect(calls).toEqual([
      "GET https://console.neon.tech/api/v2/projects/proj/branches",
      "DELETE https://console.neon.tech/api/v2/projects/proj/branches/br-x",
    ]);
  });

  it("is a no-op when the branch is gone, and fails on API errors", async () => {
    const { f, calls } = neonFetch([{ id: "br-base", name: "base" }]);
    expect(await deleteNeonPreviewBranch({ projectId: "proj", apiKey: "synthetic", fetch: f }, 12)).toBe(false);
    expect(calls).toHaveLength(1);
    const failing = neonFetch([{ id: "br-x", name: "preview/pr-12" }], 500);
    await expect(deleteNeonPreviewBranch({ projectId: "proj", apiKey: "synthetic", fetch: failing.f }, 12)).rejects.toThrow(/500/);
  });
});

describe("githubPrState", () => {
  it("maps API answers", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    expect(await githubPrState("o/r", 1, "t", reply(200, { state: "closed" }))).toBe("closed");
    expect(await githubPrState("o/r", 1, "t", reply(200, { state: "open" }))).toBe("open");
    expect(await githubPrState("o/r", 0, undefined, reply(404, {}))).toBe("missing");
    await expect(githubPrState("o/r", 1, "t", reply(500, {}))).rejects.toThrow(/500/);
  });
});
