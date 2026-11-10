// Essay pipeline status for the boss console (E5/E6 slice, T10). Runs as web_rw, owner pages only.
// Sanitized by construction: counts, fixed codes and public-domain metadata (seed title and author).
// It never selects essay text, S3 keys, text hashes, URLs or error strings. Code columns pass through
// `safeCode`, so even an odd stored value cannot render as anything but a short lowercase code.
import type { Queryable } from "./db";

export const MAX_WORK_ROWS = 20;

const URL_STATUSES = ["new", "fetched", "quarantined", "link_only", "failed"] as const;
const LINK_STATUSES = ["approved", "proposed", "rejected"] as const;
export type UrlStatus = (typeof URL_STATUSES)[number];
export type LinkStatus = (typeof LINK_STATUSES)[number];

/** A work's stage, derived from existing columns (essay_urls.status, quarantine, essays by source_url). */
export type WorkStage = "approved" | "queued" | "fetched" | "stored" | "quarantined" | "link_only" | "failed";

export interface SourceStatus {
  name: string;
  health: string;
  pausedBy: string | null;
  healthReason: string | null;
  links: Record<LinkStatus, number>;
  urls: Record<UrlStatus, number>;
}

export interface WorkRow {
  title: string;
  author: string;
  stage: WorkStage;
  /** A fixed code (a quarantine reason, `duplicate`, `retry`, `max_attempts`, the essay status) or null. */
  code: string | null;
}

export interface EssayStatus {
  sources: SourceStatus[];
  essays: { stored: number; pendingCategory: number };
  /** Open quarantine rows by reason code. */
  quarantine: Array<{ code: string; count: number }>;
  works: WorkRow[];
  worksTotal: number;
}

/** A short lowercase code, or "other" for anything else (never echoes the raw value). */
export function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : "other";
}
const codeOrNull = (v: string | null) => (v === null ? null : safeCode(v));

const n = (v: unknown) => Number(v);
const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Counts by sanitized code (odd values merge into "other"), largest first. */
function mergeCodes(rows: ReadonlyArray<{ code: string; n: string }>): Array<{ code: string; count: number }> {
  const merged = new Map<string, number>();
  for (const r of rows) merged.set(safeCode(r.code), (merged.get(safeCode(r.code)) ?? 0) + n(r.n));
  return [...merged].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function workStage(r: { urlStatus: string | null; attempts: number; essayStatus: string | null; reason: string | null }): { stage: WorkStage; code: string | null } {
  switch (r.urlStatus) {
    case null:
      return { stage: "approved", code: null };
    case "new":
      return { stage: "queued", code: r.attempts > 0 ? "retry" : null };
    case "fetched":
      return r.essayStatus !== null ? { stage: "stored", code: safeCode(r.essayStatus) } : { stage: "fetched", code: "duplicate" };
    case "quarantined":
      return { stage: "quarantined", code: r.reason === null ? "unspecified" : safeCode(r.reason) };
    case "link_only":
      return { stage: "link_only", code: null };
    case "failed":
      return { stage: "failed", code: "max_attempts" };
    default:
      return { stage: "failed", code: "other" };
  }
}

export async function essayStatus(db: Queryable): Promise<EssayStatus> {
  const sources = await db.query<{ id: string; name: string; health: string; paused_by: string | null; health_reason: string | null }>(
    "SELECT id, name, health, paused_by, health_reason FROM sources ORDER BY name, id LIMIT 50",
  );
  const links = await db.query<{ source_id: string; status: string; n: string }>(
    "SELECT source_id, status, count(*) AS n FROM seed_source_links GROUP BY source_id, status",
  );
  const urls = await db.query<{ source_id: string; status: string; n: string }>(
    "SELECT source_id, status, count(*) AS n FROM essay_urls GROUP BY source_id, status",
  );
  const essays = await db.query<{ stored: string; pending: string }>(
    `SELECT count(*) FILTER (WHERE kind = 'full') AS stored,
            count(*) FILTER (WHERE kind = 'full' AND status = 'pending_category') AS pending
       FROM essays`,
  );
  const quarantine = await db.query<{ code: string; n: string }>(
    `SELECT r.code, count(*) AS n
       FROM quarantine q
       CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(q.reasons) = 'array' THEN q.reasons ELSE '[]'::jsonb END) AS r(code)
      WHERE q.resolved_at IS NULL
      GROUP BY r.code ORDER BY n DESC, r.code`,
  );
  const works = await db.query<{
    title: string; author: string; url_status: string | null; attempts: number | null; essay_status: string | null; reason: unknown;
  }>(
    `SELECT si.title, si.author, u.status AS url_status, u.attempts, e.status AS essay_status,
            CASE WHEN jsonb_typeof(q.reasons) = 'array' THEN q.reasons -> 0 ELSE NULL END AS reason
       FROM seed_source_links l
       JOIN seed_items si ON si.id = l.seed_item_id
       LEFT JOIN essay_urls u ON u.link_id = l.id
       LEFT JOIN LATERAL (SELECT status FROM essays WHERE source_url = u.url AND kind = 'full' ORDER BY created_at LIMIT 1) e ON true
       LEFT JOIN LATERAL (SELECT reasons FROM quarantine WHERE essay_url = u.url AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 1) q ON true
      WHERE l.status = 'approved'
      ORDER BY si.title, l.id
      LIMIT $1`,
    [MAX_WORK_ROWS],
  );
  const total = await db.query<{ n: string }>("SELECT count(*) AS n FROM seed_source_links WHERE status = 'approved'");

  const bySource = new Map<string, SourceStatus>(
    sources.rows.map((s) => [
      s.id,
      { name: s.name, health: safeCode(s.health), pausedBy: codeOrNull(s.paused_by), healthReason: codeOrNull(s.health_reason), links: zero(LINK_STATUSES), urls: zero(URL_STATUSES) },
    ]),
  );
  for (const r of links.rows) {
    const s = bySource.get(r.source_id);
    if (s && (LINK_STATUSES as readonly string[]).includes(r.status)) s.links[r.status as LinkStatus] = n(r.n);
  }
  for (const r of urls.rows) {
    const s = bySource.get(r.source_id);
    if (s && (URL_STATUSES as readonly string[]).includes(r.status)) s.urls[r.status as UrlStatus] = n(r.n);
  }

  return {
    sources: [...bySource.values()],
    essays: { stored: n(essays.rows[0]?.stored ?? 0), pendingCategory: n(essays.rows[0]?.pending ?? 0) },
    quarantine: mergeCodes(quarantine.rows),
    works: works.rows.map((r) => ({
      title: r.title,
      author: r.author,
      ...workStage({ urlStatus: r.url_status, attempts: r.attempts ?? 0, essayStatus: r.essay_status, reason: typeof r.reason === "string" ? r.reason : null }),
    })),
    worksTotal: n(total.rows[0]?.n ?? 0),
  };
}
