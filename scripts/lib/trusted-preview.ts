// Trusted-side lookups for preview-trusted.yml (AR1 slices 2 and 3): which open PR a ci run belongs to, which
// artifacts (candidate-preview, candidate-prod) to download, and whether a PR head is still the one being previewed. The GitHub API is an
// interface so the logic is tested with fakes; ghRest() adapts scripts/lib/agent-github.ts.
import type { GitHubRead } from "@kcw/core/trusted-run";
import { ghGet, type GhOptions } from "./agent-github";
import { KINDS, type CandidateKind } from "./candidate-artifact";

/** The shared read-only GitHub interface (@kcw/core/trusted-run); this file adds the REST adapter. */
export type GitHubRest = GitHubRead;

export function ghRest(opts: GhOptions): GitHubRest {
  return { get: (path, what) => ghGet(opts, path, what) };
}

export interface PullSummary {
  number: number;
  state: string;
  head: { sha: string; repo: { id: number } | null };
  base: { sha: string };
}

/** The one open PR of this repository whose head is exactly `headSha`. */
export function selectPullRequest(pulls: readonly PullSummary[], headSha: string, repositoryId: number): PullSummary {
  const hits = pulls.filter((p) => p.state === "open" && p.head.sha === headSha && p.head.repo?.id === repositoryId);
  if (hits.length !== 1) throw new Error(`expected exactly one open same-repository PR with head ${headSha}, found ${hits.length}`);
  return hits[0]!;
}

export interface ArtifactSummary {
  id: number;
  name: string;
  expired: boolean;
  workflow_run?: { id: number; head_sha?: string } | null;
}

/** The one live artifact of this kind (`candidate-preview` or `candidate-prod`) that belongs to this run. */
export function selectArtifact(artifacts: readonly ArtifactSummary[], runId: number, headSha: string, kind: CandidateKind = "preview"): ArtifactSummary {
  const name = KINDS[kind].artifact;
  const hits = artifacts.filter((a) => a.name === name && !a.expired && a.workflow_run?.id === runId);
  if (hits.length !== 1) throw new Error(`expected exactly one live ${name} artifact for run ${runId}, found ${hits.length}`);
  const sha = hits[0]!.workflow_run?.head_sha;
  if (sha !== undefined && sha !== headSha) throw new Error("artifact belongs to a different head SHA");
  return hits[0]!;
}

export interface ResolveInput {
  repo: string;
  repositoryId: number;
  runId: number;
  headSha: string;
}

export interface Resolved {
  prNumber: number;
  /** The PR's base commit (the base of the lockfile diff). */
  baseSha: string;
  artifactId: number;
  prodArtifactId: number;
}

export async function resolveCandidate(api: GitHubRest, input: ResolveInput): Promise<Resolved> {
  const pulls = await api.get<PullSummary[]>(`/repos/${input.repo}/commits/${input.headSha}/pulls?per_page=100`, "listing pull requests of the head commit");
  if (!pulls) throw new Error("head commit not found");
  const pr = selectPullRequest(pulls, input.headSha, input.repositoryId);
  const find = async (kind: CandidateKind): Promise<ArtifactSummary> => {
    const listed = await api.get<{ artifacts: ArtifactSummary[] }>(
      `/repos/${input.repo}/actions/runs/${input.runId}/artifacts?name=${KINDS[kind].artifact}&per_page=100`,
      "listing run artifacts",
    );
    if (!listed) throw new Error("ci run not found");
    return selectArtifact(listed.artifacts, input.runId, input.headSha, kind);
  };
  return { prNumber: pr.number, baseSha: pr.base.sha, artifactId: (await find("preview")).id, prodArtifactId: (await find("prod")).id };
}

/**
 * current: the PR is open and its head is `headSha`. superseded: open with another head (a newer
 * run owns the preview). closed: closed or gone (nothing newer will clean up, so teardown proceeds).
 */
export type HeadState = "current" | "superseded" | "closed";

export async function checkHead(api: GitHubRest, repo: string, pr: number, headSha: string): Promise<HeadState> {
  const pull = await api.get<{ state: string; head: { sha: string } }>(`/repos/${repo}/pulls/${pr}`, `reading PR #${pr}`);
  if (!pull || pull.state !== "open") return "closed";
  return pull.head.sha === headSha ? "current" : "superseded";
}
