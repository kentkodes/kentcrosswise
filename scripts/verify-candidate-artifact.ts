// Trusted-side handling of the candidate-preview artifact (AR1 slice 2), run by preview-trusted.yml from
// the main checkout. Logic and limits: lib/candidate-artifact.ts, lib/trusted-preview.ts.
// Usage (paths are resolved against where pnpm was run; inputs come from the environment):
//   pnpm verify-candidate resolve                 env GITHUB_TOKEN, GITHUB_REPOSITORY, REPOSITORY_ID, RUN_ID, HEAD_SHA
//       -> step outputs pr_number, artifact_id, head_sha
//   pnpm verify-candidate verify --dir <d>        env REPOSITORY_ID, PR_NUMBER, RUN_ID, HEAD_SHA
//       Exactly the three files; manifest, sha256 and tar validated. Writes nothing.
//   pnpm verify-candidate extract --dir <d> --dest <root>     (same env; verifies again, then extracts <root>/.open-next)
//   pnpm verify-candidate head --pr <n> --sha <sha> [--require]    env GITHUB_TOKEN, GITHUB_REPOSITORY
//       -> step output state=current|superseded|closed; with --require, exit 1 unless current
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib/args";
import {
  checkDbDump,
  DB_FILE,
  extractEntries,
  MANIFEST_FILE,
  parseId,
  parseManifest,
  parseSha,
  validateWebArchive,
  verifyManifest,
  WEB_FILE,
} from "./lib/candidate-artifact";
import { runMain } from "./lib/main";
import { checkHead, ghRest, resolveCandidate } from "./lib/trusted-preview";

const args = parseArgs(process.argv.slice(2));
const command = process.argv[2];

function pathArg(name: string): string {
  const v = args[name];
  if (typeof v !== "string" || v === "") throw new Error(`--${name} <path> is required`);
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), v);
}

function output(values: Record<string, string>): void {
  const text = Object.entries(values)
    .map(([k, v]) => `${k}=${v}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  else process.stdout.write(text);
}

function api() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  return { repo, rest: ghRest({ repo, token }) };
}

/** Reads the three files of a downloaded artifact directory (exactly these) and verifies them; returns the tar bytes. */
function verifyDir(dir: string): Uint8Array {
  const names = readdirSync(dir).sort();
  if (names.join(",") !== [MANIFEST_FILE, DB_FILE, WEB_FILE].sort().join(",")) {
    throw new Error(`artifact must contain exactly ${[DB_FILE, WEB_FILE, MANIFEST_FILE].join(", ")}`);
  }
  const read = (name: string): Buffer => readFileSync(path.join(dir, name));
  const manifest = parseManifest(read(MANIFEST_FILE).toString("utf8"));
  const files = { [DB_FILE]: read(DB_FILE), [WEB_FILE]: read(WEB_FILE) };
  verifyManifest(
    manifest,
    {
      repositoryId: parseId(process.env.REPOSITORY_ID, "REPOSITORY_ID"),
      prNumber: parseId(process.env.PR_NUMBER, "PR_NUMBER"),
      headSha: parseSha(process.env.HEAD_SHA, "HEAD_SHA"),
      runId: parseId(process.env.RUN_ID, "RUN_ID"),
    },
    files,
  );
  checkDbDump(files[DB_FILE]);
  validateWebArchive(files[WEB_FILE]);
  return files[WEB_FILE];
}

await runMain(async () => {
  if (command === "resolve") {
    const { repo, rest } = api();
    const headSha = parseSha(process.env.HEAD_SHA, "HEAD_SHA");
    const r = await resolveCandidate(rest, {
      repo,
      repositoryId: parseId(process.env.REPOSITORY_ID, "REPOSITORY_ID"),
      runId: parseId(process.env.RUN_ID, "RUN_ID"),
      headSha,
    });
    output({ pr_number: String(r.prNumber), artifact_id: String(r.artifactId), head_sha: headSha });
    console.log(`verify-candidate: PR #${r.prNumber}, artifact ${r.artifactId}`);
  } else if (command === "verify") {
    verifyDir(pathArg("dir"));
    console.log("verify-candidate: manifest, files and archive are valid");
  } else if (command === "extract") {
    const tar = verifyDir(pathArg("dir"));
    const entries = validateWebArchive(tar);
    extractEntries(tar, entries, pathArg("dest"));
    console.log(`verify-candidate: extracted ${entries.length} entries`);
  } else if (command === "head") {
    const { repo, rest } = api();
    const pr = parseId(typeof args.pr === "string" ? args.pr : undefined, "--pr");
    const sha = parseSha(typeof args.sha === "string" ? args.sha : undefined, "--sha");
    const state = await checkHead(rest, repo, pr, sha);
    output({ state });
    console.log(`verify-candidate: PR #${pr} head ${sha} is ${state}`);
    if (args.require === true && state !== "current") throw new Error(`PR #${pr} head is no longer ${sha} (${state}); not deploying an older run`);
  } else {
    console.log("Usage: pnpm verify-candidate resolve | verify --dir <d> | extract --dir <d> --dest <root> | head --pr <n> --sha <sha> [--require]");
    if (command !== "--help") process.exitCode = 1;
  }
});
