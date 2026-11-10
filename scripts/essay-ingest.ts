// Essay ingest from the Project Gutenberg rsync mirror (docs/essays/GUTENBERG-SLICE-PLAN.md section 12).
//   --phase fetch  rsync the books into --dir, extract and validate in memory, print verdicts. No DB, no AWS.
//   --phase store  for each approved book: extract, validate, put the text in S3, then record it in the
//                  database (or quarantine it). Needs --bucket and a database; non-PGlite targets need --confirm.
// Output is book ids, counts and fixed codes only; never essay text.
// Usage: pnpm essay-ingest --phase fetch --ids "1342 84" [--dir <path>]
//        pnpm essay-ingest --phase store --ids "1342 84" --bucket <s3 bucket> [--dir <path>] [--confirm] [db option]
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { fetchPhase, IngestError, parseIds, spawnRunner, STORE_OK, storePhase, summarize } from "./lib/essay-ingest";
import { runMain } from "./lib/main";
import { createTextObjectWriter } from "./lib/pipelines/aws";
import { assertWriteAllowed } from "./lib/write-guard";

const args = parseArgs(process.argv.slice(2));
const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

await runMain(async () => {
  const phase = str(args.phase);
  if (args.help || (phase !== "fetch" && phase !== "store")) {
    console.log(`Usage:
  pnpm essay-ingest --phase fetch --ids "<book ids>" [--dir <path>]
  pnpm essay-ingest --phase store --ids "<book ids>" --bucket <s3 bucket> [--dir <path>] [--confirm] [db option]

fetch  rsync each book from a Gutenberg mirror into --dir (default $RUNNER_TEMP/gutenberg), then extract and
       validate in memory. No database and no AWS.
store  per approved book: extract, validate, S3 put (essays/text/<sha256>.txt), then the database; quarantine
       for invalid text. --confirm for any non-PGlite target. Skipped when pipelines_paused is set.

${DB_HELP}`);
    return;
  }
  const ids = parseIds(str(args.ids) ?? "");
  const dir = str(args.dir) ? here(str(args.dir) as string) : join(process.env.RUNNER_TEMP ?? tmpdir(), "gutenberg");
  const log = (line: string) => console.log(line);

  if (phase === "fetch") {
    const results = await fetchPhase(ids, { runRsync: spawnRunner, dir, log });
    log(`essay-ingest fetch: ${summarize(results.map((r) => r.code ?? `verdict_${r.verdict}`))}`);
    if (results.some((r) => r.code !== null)) process.exitCode = 1;
    return;
  }

  const bucket = str(args.bucket);
  if (!bucket) throw new IngestError("bucket_required");
  assertWriteAllowed(args, "essay-ingest store");
  const { db, close } = await openDb(args);
  const s3 = createTextObjectWriter(bucket, process.env.AWS_REGION ?? "us-east-1");
  try {
    const results = await storePhase(ids, { db, putObject: s3.putObject, dir, log });
    log(`essay-ingest store: ${summarize(results.map((r) => r.code))}`);
    if (results.some((r) => !STORE_OK.has(r.code))) process.exitCode = 1;
  } finally {
    s3.close();
    await close();
  }
});
