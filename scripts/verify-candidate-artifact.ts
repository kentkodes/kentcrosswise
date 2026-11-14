// Trusted-side handling of the candidate-preview and candidate-prod artifacts (AR1 slices 2 and 3), run by preview-trusted.yml from
// the main checkout. Logic and limits: lib/candidate-artifact.ts, lib/trusted-preview.ts.
// Usage (paths are resolved against where pnpm was run; inputs come from the environment):
//   pnpm verify-candidate resolve                 env GITHUB_TOKEN, GITHUB_REPOSITORY, REPOSITORY_ID, RUN_ID, HEAD_SHA
//       -> step outputs pr_number, base_sha, artifact_id (candidate-preview), prod_artifact_id (candidate-prod), head_sha
//   pnpm verify-candidate verify --dir <d> [--kind preview|prod]        env REPOSITORY_ID, PR_NUMBER, RUN_ID, HEAD_SHA
//       Exactly the kind's files plus the manifest; manifest, sha256 and tar validated. Writes nothing.
//   pnpm verify-candidate extract --dir <d> --dest <root> [--kind preview|prod]     (same env; verifies again, then
//       extracts <root>/.open-next, or for prod the PROD_ROOTS below <root>)
//   pnpm verify-candidate head --pr <n> --sha <sha> [--require]    env GITHUB_TOKEN, GITHUB_REPOSITORY
//       -> step output state=current|superseded|closed; with --require, exit 1 unless current
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./lib/args";
import {
  checkDbDump,
  DB_FILE,
  extractEntries,
  KINDS,
  MANIFEST_FILE,
  parseId,
  parseKind,
  parseManifest,
  parseSha,
  validateProdArchive,
  validateWebArchive,
  verifyManifest,
  type CandidateKind,
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

/** Reads the files of a downloaded artifact directory (exactly the kind's files and the manifest) and verifies them; returns the tar bytes. */
function verifyDir(dir: string, kind: CandidateKind): Uint8Array {
  const { files: names, tarFile } = KINDS[kind];
  const found = readdirSync(dir).sort();
  if (found.join(",") !== [MANIFEST_FILE, ...names].sort().join(",")) {
    throw new Error(`artifact must contain exactly ${[...names, MANIFEST_FILE].join(", ")}`);
  }
  const read = (name: string): Buffer => readFileSync(path.join(dir, name));
  const manifest = parseManifest(read(MANIFEST_FILE).toString("utf8"), kind);
  const files = Object.fromEntries(names.map((n) => [n, read(n)]));
  verifyManifest(
    manifest,
    {
      repositoryId: parseId(process.env.REPOSITORY_ID, "REPOSITORY_ID"),
      prNumber: parseId(process.env.PR_NUMBER, "PR_NUMBER"),
      headSha: parseSha(process.env.HEAD_SHA, "HEAD_SHA"),
      runId: parseId(process.env.RUN_ID, "RUN_ID"),
    },
    files,
    kind,
  );
  const tar = files[tarFile]!;
  if (kind === "preview") {
    checkDbDump(files[DB_FILE]!);
    validateWebArchive(tar);
  } else {
    validateProdArchive(tar);
  }
  return tar;
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
    output({
      pr_number: String(r.prNumber),
      base_sha: parseSha(r.baseSha, "PR base sha"),
      artifact_id: String(r.artifactId),
      prod_artifact_id: String(r.prodArtifactId),
      head_sha: headSha,
    });
    console.log(`verify-candidate: PR #${r.prNumber}, artifacts ${r.artifactId} and ${r.prodArtifactId}`);
  } else if (command === "verify") {
    verifyDir(pathArg("dir"), parseKind(args.kind));
    console.log("verify-candidate: manifest, files and archive are valid");
  } else if (command === "extract") {
    const kind = parseKind(args.kind);
    const tar = verifyDir(pathArg("dir"), kind);
    const entries = kind === "prod" ? validateProdArchive(tar) : validateWebArchive(tar);
    extractEntries(tar, entries, pathArg("dest"), KINDS[kind].roots);
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
    console.log("Usage: pnpm verify-candidate resolve | verify --dir <d> [--kind prod] | extract --dir <d> --dest <root> [--kind prod] | head --pr <n> --sha <sha> [--require]");
    if (command !== "--help") process.exitCode = 1;
  }
});
