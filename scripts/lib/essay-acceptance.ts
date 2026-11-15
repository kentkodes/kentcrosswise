// Essay MVP acceptance check (essays SPEC "Done means"): a read-only report over the library.
//   1. every approved seed item has an essay that is full text (kind 'full', active, with text key, hash and word
//      count) or link-only (kind 'link' with a source URL);
//   2. no duplicates among active essays: no repeated text hash, no pair of full texts at or above the MinHash
//      near-duplicate threshold, no same-author pair at or above the title-similarity threshold (both thresholds
//      and the functions come from packages/essays/src/validate/duplicates.ts). A full text without a MinHash
//      signature cannot be checked and counts as a failure (a re-extract run backfills it).
// Output is counts, fixed codes and essay or seed ids only; never essay text, titles or authors.
import type { Db } from "../../packages/essays/src/db";
import {
  isMetadataDuplicate, minhashSimilarity, NEAR_DUPLICATE_MIN_SIMILARITY,
} from "../../packages/essays/src/validate/duplicates";

export type AcceptanceCode =
  | "seed_without_essay" | "full_incomplete" | "link_incomplete"
  | "repeated_text_hash" | "near_duplicate" | "metadata_duplicate" | "minhash_missing";

export interface Failure {
  code: AcceptanceCode;
  /** Seed item id or essay id(s). */
  ids: string[];
}

export interface Totals {
  approved_seeds: number;
  full: number;
  link_only: number;
  quarantined: number;
  pending_category: number;
  with_hook: number;
  without_hook: number;
  categorized_by_model: number;
  categorized_seed_list: number;
  uncategorized: number;
}

export interface AcceptanceReport {
  ok: boolean;
  check1: Failure[];
  check2: Failure[];
  totals: Totals;
}

interface SeedEssayRow {
  seed_id: string;
  essay_id: string | null;
  kind: string | null;
  status: string | null;
  source_url: string | null;
  text_s3_key: string | null;
  text_hash: string | null;
  word_count: number | null;
}

interface ActiveRow {
  id: string;
  kind: string;
  title: string;
  author: string;
  text_hash: string | null;
  minhash: number[] | null;
}

const present = (v: string | null) => v !== null && v.trim() !== "";

async function checkSeeds(db: Db): Promise<Failure[]> {
  const { rows } = await db.query<SeedEssayRow>(
    `SELECT s.id AS seed_id, e.id AS essay_id, e.kind, e.status, e.source_url, e.text_s3_key, e.text_hash, e.word_count
       FROM seed_items s LEFT JOIN essays e ON e.seed_item_id = s.id
      WHERE s.status = 'approved' ORDER BY s.id, e.id`,
  );
  const failures: Failure[] = [];
  for (const r of rows) {
    if (r.essay_id === null) {
      failures.push({ code: "seed_without_essay", ids: [r.seed_id] });
    } else if (r.kind === "full") {
      if (r.status !== "active" || !present(r.text_s3_key) || !present(r.text_hash) || !(Number(r.word_count) > 0)) {
        failures.push({ code: "full_incomplete", ids: [r.essay_id] });
      }
    } else if (!present(r.source_url)) {
      failures.push({ code: "link_incomplete", ids: [r.essay_id] });
    }
  }
  return failures;
}

async function checkDuplicates(db: Db): Promise<Failure[]> {
  const { rows } = await db.query<ActiveRow>(
    "SELECT id, kind, title, author, text_hash, minhash FROM essays WHERE status = 'active' ORDER BY id",
  );
  const failures: Failure[] = [];

  const byHash = new Map<string, string[]>();
  for (const r of rows) if (r.text_hash) byHash.set(r.text_hash, [...(byHash.get(r.text_hash) ?? []), r.id]);
  for (const ids of byHash.values()) if (ids.length > 1) failures.push({ code: "repeated_text_hash", ids });

  const full = rows.filter((r) => r.kind === "full");
  for (const r of full) if (!r.minhash || r.minhash.length === 0) failures.push({ code: "minhash_missing", ids: [r.id] });
  const signed = full.filter((r) => r.minhash && r.minhash.length > 0);
  for (let i = 0; i < signed.length; i++) {
    for (let j = i + 1; j < signed.length; j++) {
      if (minhashSimilarity(signed[i]!.minhash!, signed[j]!.minhash!) >= NEAR_DUPLICATE_MIN_SIMILARITY) {
        failures.push({ code: "near_duplicate", ids: [signed[i]!.id, signed[j]!.id] });
      }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      if (isMetadataDuplicate(rows[i]!, rows[j]!)) failures.push({ code: "metadata_duplicate", ids: [rows[i]!.id, rows[j]!.id] });
    }
  }
  return failures;
}

async function totals(db: Db): Promise<Totals> {
  const n = async (sql: string) => Number((await db.query<{ n: string | number }>(sql)).rows[0]?.n ?? 0);
  const full = "FROM essays WHERE kind = 'full' AND status <> 'quarantined'";
  return {
    approved_seeds: await n("SELECT count(*) AS n FROM seed_items WHERE status = 'approved'"),
    full: await n(`SELECT count(*) AS n ${full}`),
    link_only: await n("SELECT count(*) AS n FROM essays WHERE kind = 'link' AND status <> 'quarantined'"),
    quarantined: await n("SELECT count(*) AS n FROM essays WHERE status = 'quarantined'"),
    pending_category: await n("SELECT count(*) AS n FROM essays WHERE status = 'pending_category'"),
    with_hook: await n(`SELECT count(*) AS n ${full} AND hook IS NOT NULL`),
    without_hook: await n(`SELECT count(*) AS n ${full} AND hook IS NULL`),
    categorized_by_model: await n(
      "SELECT count(*) AS n FROM essays e WHERE EXISTS (SELECT 1 FROM essay_categories c WHERE c.essay_id = e.id AND c.model <> 'seed-list')"),
    categorized_seed_list: await n(
      `SELECT count(*) AS n FROM essays e WHERE EXISTS (SELECT 1 FROM essay_categories c WHERE c.essay_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM essay_categories c WHERE c.essay_id = e.id AND c.model <> 'seed-list')`),
    uncategorized: await n("SELECT count(*) AS n FROM essays e WHERE NOT EXISTS (SELECT 1 FROM essay_categories c WHERE c.essay_id = e.id)"),
  };
}

/** Read-only: SELECTs only. */
export async function acceptancePhase(deps: { db: Db; log: (line: string) => void }): Promise<AcceptanceReport> {
  const check1 = await checkSeeds(deps.db);
  const check2 = await checkDuplicates(deps.db);
  const t = await totals(deps.db);
  const ok = check1.length === 0 && check2.length === 0;
  const { log } = deps;
  const count = (list: Failure[]) => {
    const by = new Map<string, number>();
    for (const f of list) by.set(f.code, (by.get(f.code) ?? 0) + 1);
    return [...by].map(([c, k]) => `${c}=${k}`).join(" ") || "none";
  };
  log(`essay-acceptance: check1 seeds_have_essays=${check1.length === 0 ? "pass" : "fail"} failures=${check1.length} (${count(check1)})`);
  log(`essay-acceptance: check2 no_duplicates=${check2.length === 0 ? "pass" : "fail"} failures=${check2.length} (${count(check2)})`);
  for (const f of [...check1, ...check2]) log(`essay-acceptance: failure code=${f.code} ids=${f.ids.join(",")}`);
  log(`essay-acceptance: totals ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  log(`essay-acceptance: result=${ok ? "pass" : "fail"}`);
  return { ok, check1, check2, totals: t };
}
