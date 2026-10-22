// Branch name and expiry for a preview Neon branch (D12, D20). Run by action.yml with plain `node`
// (Node >= 22.18 strips the types), so keep this file to erasable TypeScript and node: imports only.
// Unit tests: scripts/test/neon-preview-plan.test.ts.
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Preview branches expire 3 h after creation, so a crashed CI run cannot hold one for long (D20). */
export const PREVIEW_TTL_HOURS = 3;

/** Parses a PR number. 0 is allowed for the manual pr-0 test. */
export function parsePrNumber(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) {
    throw new Error(`PR_NUMBER must be a non-negative integer, got "${raw ?? ""}"`);
  }
  return Number(value);
}

export function previewBranchName(pr: number): string {
  return `preview/pr-${pr}`;
}

/** RFC 3339 UTC timestamp without milliseconds, e.g. 2026-10-22T15:04:05Z. */
export function expiresAt(now: Date, hours: number = PREVIEW_TTL_HOURS): string {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid clock");
  if (!(hours > 0)) throw new Error("hours must be positive");
  return new Date(now.getTime() + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function planOutputs(env: Readonly<Record<string, string | undefined>>, now: Date): Record<string, string> {
  const pr = parsePrNumber(env.PR_NUMBER);
  return { branch_name: previewBranchName(pr), expires_at: expiresAt(now), preview_name: `pr-${pr}` };
}

/** GitHub step outputs file format: one key=value per line (values here never contain newlines). */
export function formatOutputs(outputs: Readonly<Record<string, string>>): string {
  return Object.entries(outputs)
    .map(([k, v]) => {
      if (/[\r\n]/.test(v)) throw new Error(`output ${k} contains a newline`);
      return `${k}=${v}\n`;
    })
    .join("");
}

function main(): void {
  const outputs = planOutputs(process.env, new Date());
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, formatOutputs(outputs));
  console.log(`neon-preview: branch ${outputs.branch_name}, expires ${outputs.expires_at}`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`neon-preview: ${err instanceof Error ? err.message : "failed"}`);
    process.exitCode = 1;
  }
}
