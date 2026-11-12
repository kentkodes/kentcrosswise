// Essay ingest from the Project Gutenberg rsync mirror (docs/essays/GUTENBERG-SLICE-PLAN.md section 12).
//   --phase fetch  rsync the books into --dir, extract and validate in memory, print verdicts. No DB, no AWS.
//   --phase store  for each approved book: extract, validate, put the text in S3, then record it in the
//                  database (or quarantine it). Needs --bucket and a database; non-PGlite targets need --confirm.
//   --phase categorize  for each stored pending_category essay: classify the first 2000 words of the fetched
//                  local copy (DeepSeek), record the top type and make the essay active. Needs a database
//                  and the models secret; non-PGlite targets need --confirm.
//   --phase reextract  for each stored essay of a fetched book: re-extract the local copy with the current
//                  extractor, put the new text in S3 and update text_hash, text_s3_key and word_count (ids,
//                  status, categories and ratings kept). Needs --bucket and a database; --confirm for non-PGlite.
// Output is book ids, counts and fixed codes only; never essay text.
// Usage: pnpm essay-ingest --phase fetch --ids "1342 84" [--dir <path>]
//        pnpm essay-ingest --phase store --ids "1342 84" --bucket <s3 bucket> [--dir <path>] [--confirm] [db option]
//        pnpm essay-ingest --phase categorize --ids "1342 84" [--dir <path>] [--confirm] [db option] [--models-secret <name>]
//        pnpm essay-ingest --phase reextract --ids "1342 84" --bucket <s3 bucket> [--dir <path>] [--confirm] [db option]
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { CATEGORIZE_OK, categorizePhase, MODELS_SECRET, modelsFromSecret } from "./lib/essay-categorize";
import {
  fetchPhase, IngestError, parseIds, REEXTRACT_OK, reextractPhase, spawnRunner, STORE_OK, storePhase, summarize,
} from "./lib/essay-ingest";
import { getSecret } from "@kcw/secrets";
import { runMain } from "./lib/main";
import { createTextObjectWriter } from "./lib/pipelines/aws";
import { assertWriteAllowed } from "./lib/write-guard";

const args = parseArgs(process.argv.slice(2));
const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

await runMain(async () => {
  const phase = str(args.phase);
  if (args.help || (phase !== "fetch" && phase !== "store" && phase !== "categorize" && phase !== "reextract")) {
    console.log(`Usage:
  pnpm essay-ingest --phase fetch --ids "<book ids>" [--dir <path>]
  pnpm essay-ingest --phase store --ids "<book ids>" --bucket <s3 bucket> [--dir <path>] [--confirm] [db option]
  pnpm essay-ingest --phase categorize --ids "<book ids>" [--dir <path>] [--confirm] [db option] [--models-secret <name>]
  pnpm essay-ingest --phase reextract --ids "<book ids>" --bucket <s3 bucket> [--dir <path>] [--confirm] [db option]

fetch  rsync each book from a Gutenberg mirror into --dir (default $RUNNER_TEMP/gutenberg), then extract and
       validate in memory. No database and no AWS.
store  per approved book: extract, validate, S3 put (essays/text/<sha256>.txt), then the database; quarantine
       for invalid text. --confirm for any non-PGlite target. Skipped when pipelines_paused is set.
categorize  per stored pending_category essay: classify the first 2000 words of the fetched copy in --dir (DeepSeek;
       keys from --models-secret, default ${MODELS_SECRET}), store the
       top type and set the essay active. --confirm for any non-PGlite target. Skipped when pipelines_paused is set.
reextract  per stored essay of a fetched book: re-extract the copy in --dir with the current extractor; S3 put of the
       new text, then text_hash, text_s3_key and word_count of the same essay row (id, status, categories and
       ratings kept). Codes: reextracted, unchanged, not_stored, invalid (nothing changed, no quarantine), duplicate,
       changed_concurrently, no_files, no_usable_text. When the ids cover every stored Gutenberg essay and all are
       reextracted or unchanged, the source's extractor_version is set to the current one. --confirm for any non-PGlite target. Skipped when
       pipelines_paused is set.

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

  if (phase === "categorize") {
    assertWriteAllowed(args, "essay-ingest categorize");
    const modelsSecret = str(args["models-secret"]) ?? MODELS_SECRET;
    const { db, close } = await openDb(args);
    try {
      const results = await categorizePhase(ids, {
        db, dir, log, getModels: () => modelsFromSecret((key) => getSecret(modelsSecret, key)),
      });
      log(`essay-ingest categorize: ${summarize(results.map((r) => r.code))}`);
      if (results.some((r) => !CATEGORIZE_OK.has(r.code))) process.exitCode = 1;
    } finally {
      await close();
    }
    return;
  }

  // store and reextract: both write text to S3 and the database.
  const bucket = str(args.bucket);
  if (!bucket) throw new IngestError("bucket_required");
  assertWriteAllowed(args, `essay-ingest ${phase}`);
  const { db, close } = await openDb(args);
  const s3 = createTextObjectWriter(bucket, process.env.AWS_REGION ?? "us-east-1");
  try {
    if (phase === "store") {
      const results = await storePhase(ids, { db, putObject: s3.putObject, dir, log });
      log(`essay-ingest store: ${summarize(results.map((r) => r.code))}`);
      if (results.some((r) => !STORE_OK.has(r.code))) process.exitCode = 1;
    } else {
      const results = await reextractPhase(ids, { db, putObject: s3.putObject, dir, log });
      log(`essay-ingest reextract: ${summarize(results.map((r) => r.code))}`);
      if (results.some((r) => !REEXTRACT_OK.has(r.code))) process.exitCode = 1;
    }
  } finally {
    s3.close();
    await close();
  }
});
