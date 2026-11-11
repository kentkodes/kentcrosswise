// Essay categorize phase: gives each essay stored as `pending_category` its type and makes it `active`.
// Text comes from the books the fetch phase already rsynced (no S3 read). Providers and the secret reader
// are injected. Essay text, prompts, provider responses and keys never reach a log line or an error:
// output is ids, fixed codes, the type, the confidence and the returned model id.
import { createHash } from "node:crypto";
import { DEFAULT_DEEPSEEK_BASE_URL, DeepseekProvider, type ModelProvider } from "@kcw/core/models";
import { SecretKeyMissingError } from "@kcw/secrets";
import type { Db } from "../../packages/essays/src/db";
import { analyzeBook, assertNotPaused, bookUrl, inTransaction } from "./essay-ingest";

/** The ten essay types (migration 0001 essay_categories.type check). */
export const ESSAY_TYPES = [
  "argumentative", "critical", "comedic", "creative_lyric", "personal_memoir",
  "philosophical", "political", "science_nature", "cultural", "travel",
] as const;

/** What each type means, sent to the model with the labels. */
export const TYPE_INSTRUCTIONS = [
  "Choose the one label that best describes the essay:",
  "argumentative: argues a thesis or persuades by reasoning.",
  "critical: evaluates or interprets books, art, music, theatre or ideas.",
  "comedic: humorous, satirical or witty in tone.",
  "creative_lyric: imaginative, poetic, descriptive prose.",
  "personal_memoir: the author's own life and experience.",
  "philosophical: reflects on knowledge, ethics, existence or the good life.",
  "political: government, power, law, society or public affairs.",
  "science_nature: the natural world, science or natural history.",
  "cultural: customs, history, education, manners or the character of a people.",
  "travel: places visited, journeys and foreign lands.",
].join("\n");

/** Words of the essay sent to the model. */
export const EXCERPT_WORDS = 2000;
/** The models secret (DESIGN section 6) and its key names. */
export const MODELS_SECRET = "kcw/prod/models";
const API_KEY = "deepseek_api_key";
/** Optional: swaps the OpenAI-compatible gateway without a code change. */
const BASE_URL_KEY = "deepseek_base_url";

export type CategorizeCode =
  | "categorized" | "already_processed" | "not_stored" | "not_approved" | "text_mismatch"
  | "provider_error" | "models_unavailable" | "no_files" | "no_usable_text";

export const CATEGORIZE_OK: ReadonlySet<string> = new Set(["categorized", "already_processed"]);

/**
 * The DeepSeek provider. The key is read up front (a failure is the caller's models_unavailable); the base URL
 * key is optional, and a missing or blank one means the default gateway. No network here.
 */
export async function modelsFromSecret(read: (key: string) => Promise<string>): Promise<ModelProvider> {
  const apiKey = await read(API_KEY);
  const baseUrl = await read(BASE_URL_KEY).then((v) => v.trim(), (err: unknown) => {
    if (err instanceof SecretKeyMissingError) return "";
    throw err;
  });
  return new DeepseekProvider({ apiKey, baseUrl: baseUrl || DEFAULT_DEEPSEEK_BASE_URL });
}

export interface CategorizeDeps {
  db: Db;
  dir: string;
  /** Called at most once, when the first book needs a model; a failure is `models_unavailable`. */
  getModels: () => Promise<ModelProvider>;
  log: (line: string) => void;
}

export interface CategorizeResult {
  id: number;
  code: CategorizeCode;
  type?: string;
  confidence?: number;
  model?: string;
}

interface EssayRow {
  id: string;
  status: string;
  text_hash: string;
  approved: boolean;
  categorized: boolean;
}

/** The first `max` whitespace-separated words, single-spaced. */
export function excerpt(text: string, max: number = EXCERPT_WORDS): string {
  return text.split(/\s+/).filter(Boolean).slice(0, max).join(" ");
}

/** A provider-returned model id is printed only if it is plain; anything else could inject workflow commands. */
const safeModel = (m: string) => (/^[A-Za-z0-9._:/-]{1,80}$/.test(m) ? m : "unknown");

async function categorizeBook(
  id: number, deps: CategorizeDeps, models: () => Promise<ModelProvider>,
): Promise<CategorizeResult> {
  const { db } = deps;
  const url = bookUrl(id);
  const row = (
    await db.query<EssayRow>(
      `SELECT e.id, e.status, e.text_hash,
              EXISTS (SELECT 1 FROM seed_source_links l WHERE l.candidate_url = e.source_url AND l.status = 'approved') AS approved,
              EXISTS (SELECT 1 FROM essay_categories c WHERE c.essay_id = e.id) AS categorized
         FROM essays e WHERE e.source_url = $1 ORDER BY e.id LIMIT 1`,
      [url],
    )
  ).rows[0];
  if (!row) return { id, code: "not_stored" };
  if (row.status !== "pending_category" || row.categorized) return { id, code: "already_processed" };
  if (!row.approved) return { id, code: "not_approved" };

  const a = await analyzeBook(deps.dir, id);
  if (a.code !== null) return { id, code: a.code };
  if (createHash("sha256").update(Buffer.from(a.extraction.text, "utf8")).digest("hex") !== row.text_hash) {
    return { id, code: "text_mismatch" };
  }

  let m: ModelProvider;
  try {
    m = await models();
  } catch {
    return { id, code: "models_unavailable" };
  }
  let answer;
  try {
    answer = await m.classify(excerpt(a.extraction.text), ESSAY_TYPES, { instructions: TYPE_INSTRUCTIONS });
  } catch {
    return { id, code: "provider_error" };
  }
  if (!(ESSAY_TYPES as readonly string[]).includes(answer.label)) return { id, code: "provider_error" };
  const model = safeModel(answer.model);
  const confidence = Math.round(answer.confidence * 100) / 100;

  let activated = false;
  await inTransaction(db, async () => {
    await db.query(
      "INSERT INTO essay_categories (essay_id, type, confidence, model) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [row.id, answer.label, answer.confidence, answer.model],
    );
    const updated = await db.query("UPDATE essays SET status = 'active' WHERE id = $1 AND status = 'pending_category' RETURNING id", [row.id]);
    activated = updated.rows.length > 0;
  });
  return { id, code: activated ? "categorized" : "already_processed", type: answer.label, confidence, model };
}

/** Per id, sequentially. Stops with `pipelines_paused` (nothing done) when the pause flag is set. */
export async function categorizePhase(ids: readonly number[], deps: CategorizeDeps): Promise<CategorizeResult[]> {
  await assertNotPaused(deps.db);
  let loaded: Promise<ModelProvider> | undefined;
  const models = () => (loaded ??= deps.getModels());
  const results: CategorizeResult[] = [];
  for (const id of ids) {
    const r = await categorizeBook(id, deps, models);
    results.push(r);
    deps.log(
      `essay-ingest: id=${id} code=${r.code}` +
        (r.type ? ` type=${r.type} confidence=${r.confidence?.toFixed(2)} model=${r.model}` : ""),
    );
  }
  return results;
}
