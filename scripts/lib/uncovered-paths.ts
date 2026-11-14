// Paths of a PR that the trusted prod plan does not cover (AR1 slice 3). The trusted `prod-plan` job plans
// main's infra/prod with the PR's build as data, so the PR's own infra/** and .github/** changes are not in
// that plan; merge-rules makes each one a reason for the owner to review. Read from the GitHub API, never
// from the candidate checkout.
import type { GitHubRest } from "./trusted-preview";

interface PullInfo {
  changed_files: number;
  head: { sha: string };
}

interface PullFile {
  filename: string;
  previous_filename?: string;
}

const PER_PAGE = 100;
const COVERED_BY_OWNER_REVIEW = /^(?:infra|\.github)\//;

/** Sorted, unique PR paths (renames count both paths) starting with `infra/` or `.github/`. */
export async function listUncoveredPaths(api: GitHubRest, input: { repo: string; pr: number; headSha: string }): Promise<string[]> {
  const pull = await api.get<PullInfo>(`/repos/${input.repo}/pulls/${input.pr}`, `reading PR #${input.pr}`);
  if (!pull) throw new Error(`PR #${input.pr} not found`);
  if (pull.head.sha !== input.headSha) throw new Error(`PR #${input.pr} head is ${pull.head.sha}, not ${input.headSha}`);
  const files: PullFile[] = [];
  for (let page = 1; files.length < pull.changed_files; page++) {
    const batch = await api.get<PullFile[]>(`/repos/${input.repo}/pulls/${input.pr}/files?per_page=${PER_PAGE}&page=${page}`, `listing files of PR #${input.pr}`);
    if (!batch || batch.length === 0) break;
    files.push(...batch);
  }
  if (files.length < pull.changed_files) throw new Error(`PR #${input.pr}: listed ${files.length} of ${pull.changed_files} changed files`);
  const paths = new Set<string>();
  for (const f of files) {
    for (const p of [f.filename, f.previous_filename]) if (p !== undefined && COVERED_BY_OWNER_REVIEW.test(p)) paths.add(p);
  }
  return [...paths].sort();
}
