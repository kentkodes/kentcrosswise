// Builds the merge-rules artifact content (format 2, @kcw/core/merge-input) from already-read data.
import { parseMergeInput, serializeMergeInput, type MergeInput } from "@kcw/core/merge-input";
import { computeLockDiff } from "./lock-diff";
import type { GitHubRest } from "./trusted-preview";
import { listUncoveredPaths } from "./uncovered-paths";

export interface MergeInputSources {
  repo: string;
  pr: number;
  headSha: string;
  /** Text of the plan summary JSON (scripts/lib/plan-summary.ts output). */
  planSummary: string;
  baseLock: string;
  headLock: string;
}

/** The file text plus its parsed form. Round-trips through the consumer's parser so CI never uploads a file the orchestrator rejects. */
export async function buildMergeInput(api: GitHubRest, src: MergeInputSources): Promise<{ text: string; input: MergeInput }> {
  const lockDiff = computeLockDiff(src.baseLock, src.headLock);
  const uncoveredPaths = await listUncoveredPaths(api, { repo: src.repo, pr: src.pr, headSha: src.headSha });
  const input = parseMergeInput(
    JSON.stringify({ format: 2, pr: src.pr, headSha: src.headSha, planSummary: JSON.parse(src.planSummary) as unknown, lockDiff, uncoveredPaths }),
  );
  return { text: serializeMergeInput(input), input };
}
