// Trusted-side lookups for preview-trusted.yml (AR1 slice 2): which open PR a ci run belongs to, which
// artifact to download, and whether a PR head is still the one being previewed. The GitHub API is an
// interface so the logic is tested with fakes; ghRest() adapts scripts/lib/agent-github.ts.
import { ghGet, type GhOptions } from "./agent-github";
import { CANDIDATE_ARTIFACT } from "./candidate-artifact";

export interface GitHubRest {
  /** GET a JSON document; undefined on 404. */
  get<T>(path: string, what: string): Promise<T | undefined>;
}

export function ghRest(opts: GhOptions): GitHubRest {
  return { get: (path, what) => ghGet(opts, path, what) };
}

export interface PullSummary {
  number: number;
  state: string;
  head: { sha: string; repo: { id: number } | null };
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

/** The one live artifact `candidate-preview` that belongs to this run. */
export function selectArtifact(artifacts: readonly ArtifactSummary[], runId: number, headSha: string): ArtifactSummary {
  const hits = artifacts.filter((a) => a.name === CANDIDATE_ARTIFACT && !a.expired && a.workflow_run?.id === runId);
  if (hits.length !== 1) throw new Error(`expected exactly one live ${CANDIDATE_ARTIFACT} artifact for run ${runId}, found ${hits.length}`);
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
  artifactId: number;
}

export async function resolveCandidate(api: GitHubRest, input: ResolveInput): Promise<Resolved> {
  const pulls = await api.get<PullSummary[]>(`/repos/${input.repo}/commits/${input.headSha}/pulls?per_page=100`, "listing pull requests of the head commit");
  if (!pulls) throw new Error("head commit not found");
  const pr = selectPullRequest(pulls, input.headSha, input.repositoryId);
  const listed = await api.get<{ artifacts: ArtifactSummary[] }>(
    `/repos/${input.repo}/actions/runs/${input.runId}/artifacts?name=${CANDIDATE_ARTIFACT}&per_page=100`,
    "listing run artifacts",
  );
  if (!listed) throw new Error("ci run not found");
  const artifact = selectArtifact(listed.artifacts, input.runId, input.headSha);
  return { prNumber: pr.number, artifactId: artifact.id };
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
