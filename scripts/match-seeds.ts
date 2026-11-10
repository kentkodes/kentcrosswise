// Seed to Project Gutenberg matching.
//   plan  - match approved seeds against the catalog and write the metadata-only review table.
//           Seeds: the database (db option) or --from-seed-list. Catalog: --catalog-file, else one polite
//           fetch of the published catalog CSV. Writes no database rows.
//   apply - read the owner-confirmed table and store link decisions (approved/rejected) by seed key and
//           candidate. Prints link counts before and after. Non-PGlite targets need --confirm.
// Usage: pnpm match-seeds plan  [--from-seed-list [--file <path>]] [--catalog-file <csv>] [--out <md>] [db option]
//        pnpm match-seeds apply --ref <review-ref> [--only "<gutenberg ids>"] [--table <md>] [--confirm] [db option]
import { loadSeedList } from "@kcw/db/seed-list";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args";
import { DB_HELP, openDb } from "./lib/db";
import { runMain } from "./lib/main";
import { fetchCatalogCsv, formatLinks, parseOnly, runApply, runPlan, seedsFromDb, seedsFromList } from "./lib/match-runner";
import { assertWriteAllowed } from "./lib/write-guard";

const mode = process.argv[2];
const args = parseArgs(process.argv.slice(3));
const DEFAULT_TABLE = fileURLToPath(new URL("../docs/essays/GUTENBERG-MATCH-REVIEW.md", import.meta.url));
const here = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);
const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);

await runMain(async () => {
  if (args.help || (mode !== "plan" && mode !== "apply")) {
    console.log(`Usage:
  pnpm match-seeds plan  [--from-seed-list [--file <path>]] [--catalog-file <csv>] [--out <md>] [db option]
  pnpm match-seeds apply --ref <review-ref> [--only "<gutenberg ids>"] [--table <md>] [--confirm] [db option]

plan   writes the review table (default docs/essays/GUTENBERG-MATCH-REVIEW.md); no database rows.
apply  stores approved/rejected links from the confirmed table; --confirm for any non-PGlite target.

${DB_HELP}`);
    return;
  }

  if (mode === "plan") {
    const catalogFile = str(args["catalog-file"]);
    const outPath = str(args.out) ? here(str(args.out) as string) : DEFAULT_TABLE;
    let seeds;
    if (args["from-seed-list"] === true) seeds = seedsFromList(await loadSeedList(str(args.file)));
    else {
      const { db, close } = await openDb(args);
      try {
        seeds = await seedsFromDb(db);
      } finally {
        await close();
      }
    }
    const catalogCsv = catalogFile ? await readFile(here(catalogFile), "utf8") : await fetchCatalogCsv();
    const catalogDate = (catalogFile ? (await stat(here(catalogFile))).mtime : new Date()).toISOString().slice(0, 10);
    const c = await runPlan({ seeds, catalogCsv, catalogDate, outPath });
    console.log(`plan: ${c.seeds} seeds, ${c.candidates} candidates (tier A ${c.tierA}, tier B ${c.tierB}, auto-approvable ${c.autoApprovable}); table written`);
    return;
  }

  const ref = str(args.ref);
  if (!ref) throw new Error("apply needs --ref <review reference>, for example the commit of the confirmed table");
  const only = str(args.only) ? parseOnly(str(args.only) as string) : undefined;
  assertWriteAllowed(args, "match-seeds apply");
  const { db, label, close } = await openDb(args);
  try {
    const r = await runApply({ db, tablePath: str(args.table) ? here(str(args.table) as string) : DEFAULT_TABLE, ref, ...(only && { only }) });
    console.log(`${label}: seed_source_links before: ${formatLinks(r.before)}`);
    console.log(`${label}: ${r.result.inserted} inserted, ${r.result.updated} updated, ${r.result.skipped} unchanged`);
    console.log(`${label}: seed_source_links after: ${formatLinks(r.after)}`);
  } finally {
    await close();
  }
});
