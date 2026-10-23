// Minimal GitHub REST helper for the agent workflow scripts (agent-context, agent-publish).
// The token is the agent App's installation token; it is only ever sent as a header.

export interface GhOptions {
  /** owner/name */
  repo: string;
  token: string;
  fetch?: typeof fetch;
  apiUrl?: string;
}

export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`GitHub API returned ${status} ${what}`);
  }
}

export async function ghRequest(opts: GhOptions, method: string, path: string, body?: unknown): Promise<Response> {
  const f = opts.fetch ?? fetch;
  return f(`${opts.apiUrl ?? "https://api.github.com"}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${opts.token}`,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** GET returning JSON; `undefined` on 404; throws (status only, never the body) otherwise. */
export async function ghGet<T>(opts: GhOptions, path: string, what: string): Promise<T | undefined> {
  const res = await ghRequest(opts, "GET", path);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new GitHubApiError(res.status, what);
  return (await res.json()) as T;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  pull_request?: unknown;
}

export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged: boolean;
  merge_commit_sha: string | null;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

export interface GhReview {
  id: number;
  state: string;
  body: string | null;
  commit_id: string | null;
  user: { login: string } | null;
}

export interface GhReviewComment {
  pull_request_review_id: number | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  body: string;
}

export interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  output?: { title: string | null; summary: string | null } | null;
}
