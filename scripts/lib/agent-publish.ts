// Agent workflows, after Claude runs (P2-12): the workflow, not Claude, pushes the agent's commits
// and opens the PR or submits the review with the agent App's token. Claude runs with the
// read-only workflow token, so code it executes (the PR's own tests, for QA) never sees the App
// token. The commits are copied into a fresh repository first: the checkout Claude worked in may
// carry hooks or config written by that code.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { refusedPaths, type PushRule } from "./agents";
import { ghGet, ghRequest, GitHubApiError, type GhOptions, type GhPull } from "./agent-github";

export type GitRun = (args: readonly string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) => string;

/** Runs git with hooks off; output trimmed. Errors carry git's message, never the token (it is in env only). */
export const runGit: GitRun = (args, opts) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "-c", "diff.external=", ...args], {
    cwd: opts?.cwd,
    env: opts?.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();

export class PublishError extends Error {
  override name = "PublishError";
}

const SHA = /^[0-9a-f]{40}$/;

export interface PushOptions {
  /** Checkout Claude committed in. */
  source: string;
  /** Commit the agent started from (its commits must be on top of it). */
  baseSha: string;
  branch: string;
  rule: PushRule;
  /** Push URL, e.g. https://github.com/<repo>.git (a local path in tests). */
  remoteUrl: string;
  /** Installation token; sent as an HTTP header through git's env config, never in argv or the URL. */
  token?: string;
  git?: GitRun;
  expectedRemoteSha?: string | null;
}

export interface PushResult {
  pushed: boolean;
  headSha: string;
  files: string[];
  subjects: string[];
}

/**
 * Copies HEAD of `source` into a fresh repository, checks it is `baseSha` plus new commits that only
 * touch files the rule allows, and pushes it to `branch` (never forced). No new commits: no push.
 */
export function pushCommits(opts: PushOptions): PushResult {
  const git = opts.git ?? runGit;
  if (!SHA.test(opts.baseSha)) throw new PublishError("base sha must be a full commit sha");
  if (!/^kcw\/task-[1-9][0-9]*$/.test(opts.branch)) throw new PublishError("agents push only to kcw/task-<id> branches");
  const dir = mkdtempSync(path.join(tmpdir(), "kcw-push-"));
  try {
    git(["init", "-q"], { cwd: dir });
    git(["fetch", "-q", "--no-tags", path.resolve(opts.source), "HEAD"], { cwd: dir });
    const headSha = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
    if (headSha === opts.baseSha) return { pushed: false, headSha, files: [], subjects: [] };
    try {
      git(["merge-base", "--is-ancestor", opts.baseSha, headSha], { cwd: dir });
    } catch {
      throw new PublishError("the agent's HEAD is not based on the commit it started from");
    }
    const commits = git(["rev-list", "--reverse", `${opts.baseSha}..${headSha}`], { cwd: dir }).split("\n").filter(Boolean);
    if (commits.length > 100) throw new PublishError("too many introduced commits");
    const files: string[] = [];
    let parent = opts.baseSha;
    for (const commit of commits) {
      const parents = git(["show", "-s", "--format=%P", commit], { cwd: dir }).split(" ");
      if (parents.length !== 1 || parents[0] !== parent) throw new PublishError("introduced history must be linear");
      const changed = git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", "--no-renames", parent, commit], { cwd: dir }).split("\0").filter(Boolean);
      if (changed.length > 2000) throw new PublishError("too many changed paths");
      files.push(...changed);
      const tree = git(["ls-tree", "-r", "-z", commit], { cwd: dir }).split("\0").filter(Boolean);
      if (tree.some((entry) => /^(120000|160000) /.test(entry))) throw new PublishError("symlinks and gitlinks are refused");
      parent = commit;
    }
    const refused = refusedPaths(opts.rule, files);
    if (refused.length > 0) {
      throw new PublishError(`commits touch files this agent may not change (${opts.rule}): ${refused.slice(0, 20).join(", ")}`);
    }
    const subjects = git(["log", "--format=%s", `${opts.baseSha}..${headSha}`], { cwd: dir })
      .split("\n")
      .filter(Boolean);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (opts.token) {
      const basic = Buffer.from(`x-access-token:${opts.token}`).toString("base64");
      Object.assign(env, {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      });
    }
    try {
      if (opts.expectedRemoteSha !== undefined) {
        const remote = git(["ls-remote", opts.remoteUrl, `refs/heads/${opts.branch}`], { cwd: dir, env }).split(/\s/)[0] || null;
        if (remote !== opts.expectedRemoteSha) throw new PublishError("remote branch changed since preparation");
      }
      git(["push", "-q", opts.remoteUrl, `${headSha}:refs/heads/${opts.branch}`], { cwd: dir, env });
    } catch {
      // git's stderr is not repeated: keep the log to what we know.
      throw new PublishError(`git push to ${opts.branch} failed (not a fast-forward, or no permission)`);
    }
    return { pushed: true, headSha, files, subjects };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Opens the task PR unless one is already open for the branch. Returns its number. */
export async function ensurePull(
  gh: GhOptions,
  pr: { branch: string; base: string; title: string; body: string },
): Promise<{ number: number; created: boolean }> {
  const owner = gh.repo.split("/")[0];
  const open = await ghGet<GhPull[]>(
    gh,
    `/repos/${gh.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.branch}`)}`,
    "listing PRs",
  );
  if (open && open.length > 0) {
    if (open.length !== 1 || open[0]!.head.repo?.full_name !== gh.repo || open[0]!.head.ref !== pr.branch || open[0]!.base.ref !== pr.base) throw new PublishError("existing task PR identity does not match");
    return { number: open[0]!.number, created: false };
  }
  const res = await ghRequest(gh, "POST", `/repos/${gh.repo}/pulls`, {
    title: pr.title,
    head: pr.branch,
    base: pr.base,
    body: pr.body,
  });
  if (!res.ok) throw new GitHubApiError(res.status, "creating the PR");
  return { number: ((await res.json()) as { number: number }).number, created: true };
}

export interface ReviewDecision {
  decision: "approve" | "request_changes";
  body: string;
}

/** Parses QA's structured output (`--json-schema`); anything else is refused. */
export function parseReviewDecision(json: string | undefined): ReviewDecision {
  if (!json || Buffer.byteLength(json) > 64_000) throw new PublishError("QA review exceeds bounds");
  let x: unknown;
  try {
    x = JSON.parse(json ?? "");
  } catch {
    throw new PublishError("QA returned no structured review");
  }
  const o = x as { decision?: unknown; body?: unknown };
  if (o === null || typeof o !== "object" || (o.decision !== "approve" && o.decision !== "request_changes")) {
    throw new PublishError("QA review decision must be approve or request_changes");
  }
  if (typeof o.body !== "string" || o.body.trim() === "") throw new PublishError("QA review needs a body");
  if (Object.keys(o).sort().join(",") !== "body,decision") throw new PublishError("unexpected QA review fields");
  return { decision: o.decision, body: o.body.slice(0, 60_000) };
}

/** Submits the QA review on `commitId` (the head after QA's own test commits). */
export async function submitReview(gh: GhOptions, pr: number, commitId: string, review: ReviewDecision): Promise<void> {
  const res = await ghRequest(gh, "POST", `/repos/${gh.repo}/pulls/${pr}/reviews`, {
    commit_id: commitId,
    event: review.decision === "approve" ? "APPROVE" : "REQUEST_CHANGES",
    body: review.body,
  });
  if (!res.ok) throw new GitHubApiError(res.status, `submitting the review on PR #${pr}`);
}

/** Title and body of a task PR (public: built from the sanitized issue and commit subjects). */
export function pullText(opts: {
  agent: "developer" | "scraper" | "docs";
  taskId: number;
  issue?: number;
  issueTitle?: string;
  mergedPr?: number;
  subjects: readonly string[];
}): { title: string; body: string } {
  const commits = opts.subjects.length > 0 ? ["", "Commits:", ...opts.subjects.map((s) => `- ${s}`)] : [];
  if (opts.agent === "docs") {
    return {
      title: `docs: update after #${opts.mergedPr}`,
      body: [`Docs-keeper update after #${opts.mergedPr}.`, "", `Task ${opts.taskId}.`, ...commits].join("\n"),
    };
  }
  const who = opts.agent === "developer" ? "Developer" : "Scraper-builder";
  return {
    title: (opts.issueTitle ?? `Task ${opts.taskId}`).slice(0, 200),
    body: [`Closes #${opts.issue}`, "", `Task ${opts.taskId}, opened by the ${who} agent.`, ...commits].join("\n"),
  };
}
