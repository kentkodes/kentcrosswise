import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensurePull, parseReviewDecision, PublishError, pullText, pushCommits, runGit, submitReview } from "../lib/agent-publish";

const REPO = "kentkodes/kentcrosswise";
let root: string;
let n = 0;

const git = (cwd: string, ...args: string[]) => runGit(args, { cwd });

/** A source checkout (one base commit on main) and an empty bare "GitHub" remote holding main. */
function world() {
  const dir = path.join(root, `w${n++}`);
  const src = path.join(dir, "src");
  const remote = path.join(dir, "remote.git");
  mkdirSync(src, { recursive: true });
  git(dir, "init", "-q", "--bare", remote);
  git(src, "init", "-q", "-b", "main");
  git(src, "config", "user.email", "t@example.com");
  git(src, "config", "user.name", "t");
  git(src, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(src, "README.md"), "base\n");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "base");
  git(src, "push", "-q", remote, "main");
  const base = git(src, "rev-parse", "HEAD");
  const commit = (file: string, msg: string) => {
    mkdirSync(path.dirname(path.join(src, file)), { recursive: true });
    writeFileSync(path.join(src, file), `${msg}\n`);
    git(src, "add", "-A");
    git(src, "commit", "-q", "-m", msg);
  };
  const remoteHead = (branch: string) => {
    try {
      return git(remote, "rev-parse", `refs/heads/${branch}`);
    } catch {
      return undefined;
    }
  };
  return { src, remote, base, commit, remoteHead };
}

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "kcw-publish-test-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pushCommits", { timeout: 30_000 }, () => {
  it("pushes new commits to the task branch and lists them", () => {
    const w = world();
    w.commit("apps/web/healthz.ts", "feat: healthz");
    w.commit("apps/web/test/healthz.test.ts", "test: healthz");
    const r = pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-12", rule: "code", remoteUrl: w.remote });
    expect(r).toMatchObject({ pushed: true, files: ["apps/web/healthz.ts", "apps/web/test/healthz.test.ts"] });
    expect(r.subjects).toEqual(["test: healthz", "feat: healthz"]);
    expect(w.remoteHead("kcw/task-12")).toBe(r.headSha);
  });

  it("does nothing without new commits", () => {
    const w = world();
    const r = pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-12", rule: "code", remoteUrl: w.remote });
    expect(r.pushed).toBe(false);
    expect(w.remoteHead("kcw/task-12")).toBeUndefined();
  });

  it("refuses files outside the agent's rule and pushes nothing", () => {
    const w = world();
    w.commit("apps/web/test/a.test.ts", "test: a");
    w.commit("apps/web/src/sneaky.ts", "test: not really");
    expect(() => pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-12", rule: "tests", remoteUrl: w.remote })).toThrow(
      /may not change \(tests\): apps\/web\/src\/sneaky\.ts/,
    );
    const v = world();
    v.commit(".github/workflows/x.yml", "ci");
    expect(() => pushCommits({ source: v.src, baseSha: v.base, branch: "kcw/task-12", rule: "code", remoteUrl: v.remote })).toThrow(
      PublishError,
    );
    expect(w.remoteHead("kcw/task-12")).toBeUndefined();
    expect(v.remoteHead("kcw/task-12")).toBeUndefined();
  });

  it("refuses a HEAD that is not on top of the start commit", () => {
    const w = world();
    git(w.src, "checkout", "-q", "--orphan", "other");
    w.commit("x.ts", "unrelated history");
    expect(() => pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-12", rule: "code", remoteUrl: w.remote })).toThrow(
      /not based on the commit it started from/,
    );
  });

  it("never force-pushes: a moved remote branch fails", () => {
    const w = world();
    w.commit("a.ts", "one");
    pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-12", rule: "code", remoteUrl: w.remote });
    const w2Base = w.base;
    git(w.src, "reset", "-q", "--hard", w2Base);
    w.commit("b.ts", "two");
    expect(() => pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-12", rule: "code", remoteUrl: w.remote })).toThrow(
      /not a fast-forward/,
    );
  });

  it("only pushes to kcw/task-<id> branches and needs a full sha", () => {
    const w = world();
    expect(() => pushCommits({ source: w.src, baseSha: w.base, branch: "main", rule: "code", remoteUrl: w.remote })).toThrow(/kcw\/task/);
    expect(() => pushCommits({ source: w.src, baseSha: "HEAD", branch: "kcw/task-1", rule: "code", remoteUrl: w.remote })).toThrow(/full commit sha/);
  });

  it("ignores hooks in the source checkout", () => {
    const w = world();
    mkdirSync(path.join(w.src, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(w.src, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    w.commit("a.ts", "one");
    expect(pushCommits({ source: w.src, baseSha: w.base, branch: "kcw/task-3", rule: "code", remoteUrl: w.remote }).pushed).toBe(true);
  });
});

function fakeApi(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const p = String(url).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path: p, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = routes[`${method} ${p}`];
    return r ? Response.json(r.body, { status: r.status ?? 200 }) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { gh: { repo: REPO, token: "t", fetch: f }, calls };
}

describe("ensurePull", () => {
  const LIST = `GET /repos/${REPO}/pulls?state=open&head=kentkodes%3Akcw%2Ftask-12`;
  it("opens the PR when none is open", async () => {
    const api = fakeApi({ [LIST]: { body: [] }, [`POST /repos/${REPO}/pulls`]: { status: 201, body: { number: 31 } } });
    const r = await ensurePull(api.gh, { branch: "kcw/task-12", base: "main", title: "T", body: "Closes #5" });
    expect(r).toEqual({ number: 31, created: true });
    expect(api.calls[1]!.body).toEqual({ title: "T", head: "kcw/task-12", base: "main", body: "Closes #5" });
  });
  it("reuses the open PR (fix mode)", async () => {
    const api = fakeApi({ [LIST]: { body: [{ number: 30 }] } });
    expect(await ensurePull(api.gh, { branch: "kcw/task-12", base: "main", title: "T", body: "B" })).toEqual({ number: 30, created: false });
    expect(api.calls).toHaveLength(1);
  });
});

describe("QA review", () => {
  it("parses only a well-formed decision", () => {
    expect(parseReviewDecision('{"decision":"approve","body":"LGTM: all checks pass"}')).toEqual({
      decision: "approve",
      body: "LGTM: all checks pass",
    });
    for (const bad of [undefined, "", "nope", '{"decision":"merge","body":"x"}', '{"decision":"approve","body":" "}', "null"]) {
      expect(() => parseReviewDecision(bad)).toThrow(PublishError);
    }
  });

  it("submits APPROVE / REQUEST_CHANGES on the given commit", async () => {
    const sha = "c".repeat(40);
    const api = fakeApi({ [`POST /repos/${REPO}/pulls/9/reviews`]: { body: {} } });
    await submitReview(api.gh, 9, sha, { decision: "request_changes", body: "1. x" });
    expect(api.calls[0]!.body).toEqual({ commit_id: sha, event: "REQUEST_CHANGES", body: "1. x" });
    const fail = fakeApi({});
    await expect(submitReview(fail.gh, 9, sha, { decision: "approve", body: "ok" })).rejects.toThrow(/404 submitting the review/);
  });
});

describe("pullText", () => {
  it("developer: issue title, Closes #n, commit subjects", () => {
    expect(pullText({ agent: "developer", taskId: 12, issue: 5, issueTitle: "Add a healthz page", subjects: ["feat: healthz"] })).toEqual({
      title: "Add a healthz page",
      body: "Closes #5\n\nTask 12, opened by the Developer agent.\n\nCommits:\n- feat: healthz",
    });
  });
  it("docs: no Closes, names the merged PR", () => {
    const t = pullText({ agent: "docs", taskId: 13, mergedPr: 9, subjects: [] });
    expect(t.title).toBe("docs: update after #9");
    expect(t.body).not.toMatch(/Closes/);
  });
});
