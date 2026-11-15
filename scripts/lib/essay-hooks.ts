// Essay hook phase: writes the one-line hook shown on an essay card (essays SPEC "Feed") for each stored
// full-text essay that has none. Text comes from the books the fetch phase already rsynced (no S3 read).
// The provider is injected exactly like the categorize phase's (`getModels`), so one wrapper around it can
// later count usage for both phases. Essay text, prompts, replies and keys never reach a log line or an
// error: output is ids, fixed codes and the returned model id. A reply that fails validation is stored as nothing.
import { createHash } from "node:crypto";
import type { ModelProvider } from "@kcw/core/models";
import type { Db } from "../../packages/essays/src/db";
import { normalizeForHash } from "../../packages/essays/src/validate/duplicates";
import { excerpt, safeModel } from "./essay-categorize";
import { analyzeBook, assertNotPaused, bookUrl, ESSAY_TEXT_PREFIX } from "./essay-ingest";

/** Words of the essay sent to the model. */
export const HOOK_EXCERPT_WORDS = 1500;
/** Longest accepted hook, in characters. */
export const HOOK_MAX_CHARS = 160;
/** A hook may not repeat more than this many consecutive words of the essay. */
export const HOOK_MAX_QUOTED_WORDS = 5;
const HOOK_MAX_TOKENS = 200;

export const HOOK_SYSTEM = [
  "You write the one-line hook that invites a reader to open an essay.",
  `Reply with exactly one plain-text sentence of at most ${HOOK_MAX_CHARS} characters and nothing else.`,
  "Do not quote the essay beyond a few words, do not reveal its conclusion, do not name the author or the title,",
  "and use no markdown, quotation marks or lists.",
].join(" ");

export type HookCode =
  | "hooked" | "already_processed" | "link_only" | "not_stored" | "quarantined" | "not_active" | "changed_concurrently" | "text_mismatch"
  | "provider_error" | "invalid_hook" | "models_unavailable" | "no_files" | "no_usable_text";

export const HOOK_OK: ReadonlySet<string> = new Set(["hooked", "already_processed", "link_only"]);

export interface HookContext {
  title: string;
  author: string;
  /** The full essay text, used only to detect long quotations. */
  text: string;
}

const QUOTE_EDGE = /^["'“”‘’„‚«»]|["'“”‘’„‚«»]$/u;
const letterWords = (s: string): string[] => s.split(/[^\p{L}]+/u).filter(Boolean);

const words = (s: string): string[] => normalizeForHash(s).split(" ").filter(Boolean);

/**
 * The hook to store, or null when the reply is not acceptable: the reply must have ended normally, be one
 * non-empty plain line of at most HOOK_MAX_CHARS characters, repeat no more than HOOK_MAX_QUOTED_WORDS
 * consecutive words of the essay, and name neither the author (any name part of 2+ letters as a whole word)
 * nor the title (when it has two or more words).
 */
export function validateHook(reply: { text: string; stop: string }, ctx: HookContext): string | null {
  if (reply.stop !== "end") return null;
  const hook = reply.text.trim();
  if (hook.length === 0 || hook.length > HOOK_MAX_CHARS) return null;
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(hook)) return null; // also rejects any line break
  if (/[*_`#<>[\]|\\]/.test(hook) || /^\s*[-+>]\s/.test(hook) || QUOTE_EDGE.test(hook)) return null;

  const hw = words(hook);
  if (hw.length === 0) return null;
  const ew = words(ctx.text);
  const n = HOOK_MAX_QUOTED_WORDS + 1;
  if (hw.length >= n) {
    const seen = new Set<string>();
    for (let i = 0; i + n <= ew.length; i++) seen.add(ew.slice(i, i + n).join(" "));
    for (let i = 0; i + n <= hw.length; i++) if (seen.has(hw.slice(i, i + n).join(" "))) return null;
  }
  const padded = ` ${hw.join(" ")} `;
  // Author: whole words split on any non-letter (so a possessive counts). Parts of 4+ letters match in any case;
  // parts of 2-3 letters only in the exact case, so a name part such as "An" does not reject the common word "an".
  const hookLetters = letterWords(hook);
  for (const part of letterWords(ctx.author)) {
    if (part.length < 2) continue;
    const hit = part.length >= 4
      ? hookLetters.some((w) => w.toLowerCase() === part.toLowerCase())
      : hookLetters.includes(part);
    if (hit) return null;
  }
  const tw = words(ctx.title);
  if (tw.length >= 2 && padded.includes(` ${tw.join(" ")} `)) return null;
  return hook;
}

export interface HooksDeps {
  db: Db;
  dir: string;
  /** Called at most once, when the first book needs a model; a failure is `models_unavailable`. */
  getModels: () => Promise<ModelProvider>;
  log: (line: string) => void;
}

export interface HookResult {
  id: number;
  code: HookCode;
  model?: string;
}

interface EssayRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  author: string;
  hook: string | null;
  text_s3_key: string | null;
}

async function hookBook(id: number, deps: HooksDeps, models: () => Promise<ModelProvider>): Promise<HookResult> {
  const { db } = deps;
  const row = (
    await db.query<EssayRow>(
      "SELECT id, kind, status, title, author, hook, text_s3_key FROM essays WHERE source_url = $1 ORDER BY id LIMIT 1",
      [bookUrl(id)],
    )
  ).rows[0];
  if (!row) return { id, code: "not_stored" };
  if (row.kind !== "full") return { id, code: "link_only" };
  if (row.status === "quarantined") return { id, code: "quarantined" };
  if (row.status !== "active") return { id, code: "not_active" };
  if (row.hook !== null) return { id, code: "already_processed" };

  const a = await analyzeBook(deps.dir, id);
  if (a.code !== null) return { id, code: a.code };
  const text = a.extraction.text;
  const contentKey = `${ESSAY_TEXT_PREFIX}${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}.txt`;
  if (contentKey !== row.text_s3_key) return { id, code: "text_mismatch" };

  let m: ModelProvider;
  try {
    m = await models();
  } catch {
    return { id, code: "models_unavailable" };
  }
  let reply;
  try {
    reply = await m.complete({ system: HOOK_SYSTEM, prompt: excerpt(text, HOOK_EXCERPT_WORDS), maxTokens: HOOK_MAX_TOKENS });
  } catch {
    return { id, code: "provider_error" };
  }
  const model = safeModel(reply.model);
  const hook = validateHook(reply, { title: row.title, author: row.author, text });
  if (hook === null) return { id, code: "invalid_hook", model };

  // Active full text only: a row quarantined or changed during the model call gets no hook.
  const updated = await db.query(
    "UPDATE essays SET hook = $1 WHERE id = $2 AND hook IS NULL AND status = 'active' AND kind = 'full' RETURNING id",
    [hook, row.id],
  );
  return { id, code: updated.rows.length > 0 ? "hooked" : "changed_concurrently", model };
}

/** Per id, sequentially. Stops with `pipelines_paused` (nothing done) when the pause flag is set. */
export async function hooksPhase(ids: readonly number[], deps: HooksDeps): Promise<HookResult[]> {
  await assertNotPaused(deps.db);
  let loaded: Promise<ModelProvider> | undefined;
  const models = () => (loaded ??= deps.getModels());
  const results: HookResult[] = [];
  for (const id of ids) {
    const r = await hookBook(id, deps, models);
    results.push(r);
    deps.log(`essay-ingest: id=${id} code=${r.code}${r.model ? ` model=${r.model}` : ""}`);
  }
  return results;
}
