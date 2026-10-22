import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appIdArg,
  applyRuleset,
  checksWithoutSource,
  compareRuleset,
  fetchRuleset,
  GITHUB_ACTIONS_APP_ID,
  loadExpected,
  profileArg,
  requestBody,
  type Ruleset,
} from "../lib/repo-settings";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/rulesets/${name}.json`, import.meta.url), "utf8")) as Ruleset;

const APP_ID = 2000001; // synthetic orchestrator App id used in the fixtures

describe("expected rulesets (DESIGN §4.1)", () => {
  it("final: PR with 1 approval, stale dismissal, squash only, two sourced checks, no bypass", () => {
    const r = loadExpected("final", APP_ID);
    expect(r.name).toBe("main-protection");
    expect(r.enforcement).toBe("active");
    expect(r.bypass_actors).toEqual([]);
    expect(r.rules?.map((x) => x.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request", "required_status_checks"]);
    const pr = r.rules?.find((x) => x.type === "pull_request")?.parameters;
    expect(pr).toMatchObject({
      required_approving_review_count: 1,
      dismiss_stale_reviews_on_push: true,
      require_last_push_approval: false,
      allowed_merge_methods: ["squash"],
    });
    const checks = r.rules?.find((x) => x.type === "required_status_checks")?.parameters?.required_status_checks;
    expect(checks).toEqual([
      { context: "ci/required", integration_id: GITHUB_ACTIONS_APP_ID },
      { context: "kcw/merge-rules", integration_id: APP_ID },
    ]);
    expect(checksWithoutSource(r)).toEqual([]);
  });

  it("final without the App id keeps kcw/merge-rules unsourced (apply refuses it)", () => {
    expect(checksWithoutSource(loadExpected("final"))).toEqual(["kcw/merge-rules"]);
  });

  it("interim: same protections, 0 approvals, only ci/required", () => {
    const r = loadExpected("interim");
    expect(r.rules?.find((x) => x.type === "pull_request")?.parameters?.required_approving_review_count).toBe(0);
    expect(r.rules?.find((x) => x.type === "required_status_checks")?.parameters?.required_status_checks).toEqual([
      { context: "ci/required", integration_id: GITHUB_ACTIONS_APP_ID },
    ]);
    expect(checksWithoutSource(r)).toEqual([]);
  });

  it("request body drops read-only fields", () => {
    expect(Object.keys(requestBody({ ...loadExpected("interim"), id: 1 })).sort()).toEqual([
      "bypass_actors",
      "conditions",
      "enforcement",
      "name",
      "rules",
      "target",
    ]);
  });
});

describe("compareRuleset", () => {
  it("matches GitHub's response for the final profile (extra response fields ignored)", () => {
    expect(compareRuleset(loadExpected("final", APP_ID), fixture("final-ok"))).toEqual({ drift: [], warnings: [] });
  });

  it("matches the interim profile; refs/heads/main counts as the default branch", () => {
    expect(compareRuleset(loadExpected("interim"), fixture("interim-ok"))).toEqual({
      drift: [],
      warnings: ["bypass list not visible with this token (needs admin read); not checked"],
    });
  });

  it("reports a missing ruleset", () => {
    expect(compareRuleset(loadExpected("interim"), undefined).drift).toEqual(['ruleset "main-protection" does not exist']);
  });

  it("reports every kind of drift", () => {
    const { drift } = compareRuleset(loadExpected("final", APP_ID), fixture("drifted"));
    expect(drift).toEqual([
      'enforcement: expected "active", found "evaluate"',
      'excluded branches: expected [], found ["refs/heads/hotfix"]',
      "bypass list must be empty, found 1 actor(s)",
      'rule "non_fast_forward" is missing',
      'unexpected rule "required_signatures"',
      "pull_request.dismiss_stale_reviews_on_push: expected true, found false",
      "pull_request.require_last_push_approval: expected false, found true",
      'pull_request.allowed_merge_methods: expected ["squash"], found ["merge","squash"]',
      'required status check "ci/required": expected source app 15368, found any source',
      'required status check "kcw/merge-rules" is missing',
      "unexpected required status check checks (app 15368)",
    ]);
  });

  it("final profile without the App id warns instead of checking the merge-rules source", () => {
    const { drift, warnings } = compareRuleset(loadExpected("final"), fixture("final-ok"));
    expect(drift).toEqual([]);
    expect(warnings).toEqual(['source of "kcw/merge-rules" not checked (orchestrator App id unknown)']);
  });

  it("the interim ruleset is drift against the final profile", () => {
    const { drift } = compareRuleset(loadExpected("final", APP_ID), fixture("interim-ok"));
    expect(drift).toContain("pull_request.required_approving_review_count: expected 1, found 0");
    expect(drift).toContain('required status check "kcw/merge-rules" is missing');
  });
});

describe("argument helpers", () => {
  it("parse the profile and App id", () => {
    expect(profileArg(undefined)).toBe("final");
    expect(profileArg("interim")).toBe("interim");
    expect(() => profileArg("strict")).toThrow(/--profile/);
    expect(appIdArg("123")).toBe(123);
    expect(() => appIdArg("12x")).toThrow(/positive integer/);
  });
});

describe("GitHub REST calls", () => {
  function fakeGitHub(existing: { id: number; name: string }[], detail?: Ruleset) {
    const calls: { method: string; url: string; body?: unknown; auth: string | null }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get("authorization") });
      const u = new URL(String(url));
      if (method === "GET" && u.pathname.endsWith("/rulesets")) return new Response(JSON.stringify(existing), { status: 200 });
      if (method === "GET") return new Response(JSON.stringify(detail), { status: 200 });
      return new Response(JSON.stringify({ id: 77 }), { status: method === "POST" ? 201 : 200 });
    }) as typeof fetch;
    return { f, calls };
  }

  it("reads the named ruleset, or undefined", async () => {
    const { f, calls } = fakeGitHub([{ id: 5, name: "other" }, { id: 9100002, name: "main-protection" }], fixture("interim-ok"));
    const r = await fetchRuleset({ repo: "o/r", token: "synthetic", fetch: f });
    expect(r?.id).toBe(9100002);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r/rulesets?per_page=100&includes_parents=false",
      "GET https://api.github.com/repos/o/r/rulesets/9100002",
    ]);
    expect(calls[0]?.auth).toBe("Bearer synthetic");
    expect(await fetchRuleset({ repo: "o/r", fetch: fakeGitHub([]).f })).toBeUndefined();
  });

  it("creates when missing and replaces when present", async () => {
    const created = fakeGitHub([]);
    expect(await applyRuleset({ repo: "o/r", token: "t", fetch: created.f }, loadExpected("interim"))).toEqual({ action: "created", id: 77 });
    expect(created.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.github.com/repos/o/r/rulesets" });
    expect(created.calls.at(-1)?.body).toEqual(requestBody(loadExpected("interim")));

    const updated = fakeGitHub([{ id: 9100002, name: "main-protection" }], fixture("interim-ok"));
    expect(await applyRuleset({ repo: "o/r", token: "t", fetch: updated.f }, loadExpected("interim"))).toEqual({ action: "updated", id: 77 });
    expect(updated.calls.at(-1)).toMatchObject({ method: "PUT", url: "https://api.github.com/repos/o/r/rulesets/9100002" });
  });
});
