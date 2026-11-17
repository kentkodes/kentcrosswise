// Social dashboard (H11, hub SPEC feature 5): accounts, daily snapshots of followers and views, totals,
// change against the previous known value and the followers trend. Runs as web_rw through withDb; owner
// pages only. Manual entry is the only writer in this PR. API ingestion (YouTube, Instagram, TikTok) writes
// the same tables: accounts with ingest 'api' and snapshots through upsertSnapshot.
//
// Never log handles or numbers: callers log error codes and classes only.
import type { Queryable } from "./db";

export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const SOURCES = ["all", ...PLATFORMS] as const;
export type Source = (typeof SOURCES)[number];
export const INGESTS = ["manual", "api"] as const;
export type Ingest = (typeof INGESTS)[number];
/** The platforms the daily job reads (one API account each). TikTok is manual entry only. */
export const API_PLATFORMS = ["youtube", "instagram"] as const;

export const MAX_HANDLE_CHARS = 64;
/** Snapshots per account that feed the followers trend (the newest days). */
export const TREND_POINTS = 30;
/** The earliest day a snapshot may carry (earlier years are typos; Postgres would also reject year 0000). */
export const MIN_DAY = "2000-01-01";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS = /^\d+$/;
/** ASCII only, 1 to MAX_HANDLE_CHARS characters (checked with the length below). */
const HANDLE = /^[A-Za-z0-9._-]+$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Input problems, as fixed codes (the page shows text for each code; the message is never shown or logged). */
export type SocialErrorCode =
  | "platform"
  | "handle"
  | "duplicate"
  | "account"
  | "day"
  | "followers"
  | "views"
  | "empty"
  | "ingest"
  | "api-tiktok"
  | "api-taken-youtube"
  | "api-taken-instagram";

export class SocialInputError extends Error {
  override name = "SocialInputError";
  readonly code: SocialErrorCode;
  constructor(code: SocialErrorCode) {
    super(code);
    this.code = code;
  }
}

/** The UTC day as YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** A day for display, in plain text: "2026-11-12" becomes "12 Nov". */
export function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${Number(date)} ${MONTHS[Number(month) - 1]}`;
}

// ---------------------------------------------------------------- parsing (form and API input)

/** The source filter from a query string. Anything unknown means all sources. */
export function parseSource(raw: unknown): Source {
  return typeof raw === "string" && (SOURCES as readonly string[]).includes(raw) ? (raw as Source) : "all";
}

export function parsePlatform(raw: unknown): Platform {
  if (typeof raw !== "string" || !(PLATFORMS as readonly string[]).includes(raw)) throw new SocialInputError("platform");
  return raw as Platform;
}

/** How an account's numbers arrive: typed in by hand, or read by the daily job. Anything else is invalid. */
export function parseIngest(raw: unknown): Ingest {
  if (typeof raw !== "string" || !(INGESTS as readonly string[]).includes(raw)) throw new SocialInputError("ingest");
  return raw as Ingest;
}

/**
 * Trims, drops leading "@" signs, lower-cases, then checks the characters (ASCII letters, digits, ".", "_",
 * "-") and the length. The result is what is stored: platforms treat handles case-insensitively, and the
 * unique constraint is case-sensitive, so the stored form is the lower-case one.
 */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== "string") throw new SocialInputError("handle");
  const handle = raw.trim().replace(/^@+/, "").trim().toLowerCase();
  if (handle.length === 0 || handle.length > MAX_HANDLE_CHARS || !HANDLE.test(handle)) throw new SocialInputError("handle");
  return handle;
}

/** A form count: empty means no number (null); otherwise digits only, within the safe integer range. */
export function parseCount(raw: unknown, field: "followers" | "views"): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new SocialInputError(field);
  const text = raw.trim();
  if (text === "") return null;
  if (!DIGITS.test(text)) throw new SocialInputError(field);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new SocialInputError(field);
  return n;
}

/** A YYYY-MM-DD day that exists, is not before MIN_DAY and is not after `today` (UTC). */
export function parseDay(raw: unknown, today: string = todayUtc()): string {
  if (typeof raw !== "string" || !DAY.test(raw)) throw new SocialInputError("day");
  const ms = Date.parse(`${raw}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; require a round trip.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== raw) throw new SocialInputError("day");
  if (raw < MIN_DAY || raw > today) throw new SocialInputError("day");
  return raw;
}

function checkCount(value: number | null, field: "followers" | "views"): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new SocialInputError(field);
  return value;
}

export interface SnapshotInput {
  accountId: string;
  day: string;
  followers: number | null;
  views: number | null;
  followersExact: boolean;
}

/**
 * Checks a snapshot before it is stored: a known account id, a day that is not in the future, whole
 * non-negative numbers (either may be null, not both), and a boolean for exact followers.
 */
export function checkSnapshot(input: SnapshotInput, today: string = todayUtc()): SnapshotInput {
  if (typeof input.accountId !== "string" || !UUID.test(input.accountId)) throw new SocialInputError("account");
  const day = parseDay(input.day, today);
  const followers = checkCount(input.followers, "followers");
  const views = checkCount(input.views, "views");
  if (followers === null && views === null) throw new SocialInputError("empty");
  if (typeof input.followersExact !== "boolean") throw new SocialInputError("followers");
  return { accountId: input.accountId, day, followers, views, followersExact: input.followersExact };
}

/** The snapshot from the manual entry form. The checkbox "followers_rounded" marks rounded followers. */
export function snapshotFromForm(form: FormData, today: string = todayUtc()): SnapshotInput {
  const account = form.get("account_id");
  const day = form.get("day");
  return checkSnapshot(
    {
      accountId: typeof account === "string" ? account : "",
      day: typeof day === "string" ? day : "",
      followers: parseCount(form.get("followers"), "followers"),
      views: parseCount(form.get("views"), "views"),
      followersExact: form.get("followers_rounded") !== "on",
    },
    today,
  );
}

/** The account from the add form: platform, handle and how its numbers arrive (the ingest select). */
export function newAccountFromForm(form: FormData): NewAccount {
  return {
    platform: parsePlatform(form.get("platform")),
    handle: normalizeHandle(form.get("handle")),
    ingest: parseIngest(form.get("ingest")),
  };
}

export interface NewAccount {
  platform: Platform;
  handle: string;
  /** Defaults to manual when omitted. */
  ingest?: Ingest;
}

// ---------------------------------------------------------------- database

function sqlState(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * A bigint or int column as a JS number. node-postgres returns int8 as a string and PGlite returns a
 * number; both become a safe integer here, and anything else is a bug, not a number to show.
 */
export function toCount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string" && DIGITS.test(v)) n = Number(v);
  else throw new Error("social: count column has an unexpected type");
  if (!Number.isSafeInteger(n)) throw new Error("social: count column is outside the safe integer range");
  return n;
}

/**
 * Inserts the account with the given ingest (manual by default) and returns its id. A platform and handle
 * that is already on the dashboard throws "duplicate" (handles are stored lower-case, so case does not make
 * a second account). An ingest 'api' account is allowed only for YouTube and Instagram, and only one per
 * platform, because the daily job reads a single one. The one-per-platform check runs under an advisory
 * lock in the caller's transaction (withDb), so two saves at once cannot both pass it.
 */
export async function addAccount(db: Queryable, input: NewAccount): Promise<string> {
  const platform = parsePlatform(input.platform);
  const handle = normalizeHandle(input.handle);
  const ingest = parseIngest(input.ingest ?? "manual");
  if (ingest === "api") {
    if (!(API_PLATFORMS as readonly string[]).includes(platform)) throw new SocialInputError("api-tiktok");
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`social-api:${platform}`]);
    const { rows: taken } = await db.query(
      "SELECT 1 FROM social_accounts WHERE platform = $1 AND ingest = 'api' LIMIT 1",
      [platform],
    );
    if (taken.length > 0) throw new SocialInputError(platform === "youtube" ? "api-taken-youtube" : "api-taken-instagram");
  }
  try {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO social_accounts (platform, handle, ingest) VALUES ($1, $2, $3) RETURNING id",
      [platform, handle, ingest],
    );
    return rows[0]!.id;
  } catch (err) {
    if (sqlState(err) === "23505") throw new SocialInputError("duplicate");
    throw err;
  }
}

/** Deletes the account; its snapshots go with it (ON DELETE CASCADE). False when no such account. */
export async function deleteAccount(db: Queryable, accountId: string): Promise<boolean> {
  if (typeof accountId !== "string" || !UUID.test(accountId)) throw new SocialInputError("account");
  const { rows } = await db.query<{ id: string }>("DELETE FROM social_accounts WHERE id = $1 RETURNING id", [accountId]);
  return rows.length > 0;
}

/**
 * Writes one day's numbers for an account. A second save for the same account and day replaces that
 * day's numbers (UNIQUE (account_id, day)), including clearing a field that is now empty. Used by the
 * manual form and by the API ingestion PRs.
 */
export async function upsertSnapshot(db: Queryable, input: SnapshotInput): Promise<void> {
  const s = checkSnapshot(input);
  try {
    await db.query(
      `INSERT INTO social_snapshots (account_id, day, followers, views, followers_exact)
       VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (account_id, day) DO UPDATE SET
         followers = EXCLUDED.followers,
         views = EXCLUDED.views,
         followers_exact = EXCLUDED.followers_exact`,
      [s.accountId, s.day, s.followers, s.views, s.followersExact],
    );
  } catch (err) {
    if (sqlState(err) === "23503") throw new SocialInputError("account");
    throw err;
  }
}

/** One metric's latest known value, and the day it was entered for. */
export interface Known {
  value: number;
  day: string;
}

export interface FollowersKnown extends Known {
  /** False when the platform gave a rounded count for that day. */
  exact: boolean;
}

export interface AccountRow {
  id: string;
  platform: Platform;
  handle: string;
  ingest: Ingest;
  /** All snapshots of the account (for the delete confirmation). */
  snapshots: number;
  /** Day of the newest snapshot (any metric), or null when the account has none. */
  day: string | null;
  /** Latest followers that were entered (the newest day with a followers number), or null. */
  followers: FollowersKnown | null;
  /** Latest views that were entered (the newest day with a views number), or null. */
  views: Known | null;
  /**
   * Latest known value minus the previous known value of the same metric (the day before it that has one).
   * Null when there is no earlier known value.
   */
  change: { followers: number | null; views: number | null };
  /** Followers of the newest TREND_POINTS days that have a followers number, oldest first. */
  trend: number[];
}

interface RawAccount {
  id: string;
  platform: Platform;
  handle: string;
  ingest: Ingest;
  snapshots: unknown;
  day: string | null;
  followers_day: string | null;
  followers: unknown;
  followers_exact: boolean | null;
  prev_followers: unknown;
  views_day: string | null;
  views: unknown;
  prev_views: unknown;
}

// Each metric has its own lateral lookup: the newest snapshot with a number for that metric, and the
// newest one before it. A newer day with the metric left empty therefore does not hide the older number.
const LIST_SQL = `
  SELECT a.id, a.platform, a.handle, a.ingest,
         (SELECT count(*)::int FROM social_snapshots c WHERE c.account_id = a.id) AS snapshots,
         n.day::text AS day,
         f.day::text AS followers_day, f.followers, f.followers_exact,
         pf.followers AS prev_followers,
         v.day::text AS views_day, v.views,
         pv.views AS prev_views
    FROM social_accounts a
    LEFT JOIN LATERAL (
      SELECT s.day FROM social_snapshots s
       WHERE s.account_id = a.id
       ORDER BY s.day DESC
       LIMIT 1
    ) n ON true
    LEFT JOIN LATERAL (
      SELECT s.day, s.followers, s.followers_exact FROM social_snapshots s
       WHERE s.account_id = a.id AND s.followers IS NOT NULL
       ORDER BY s.day DESC
       LIMIT 1
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT s.followers FROM social_snapshots s
       WHERE s.account_id = a.id AND s.followers IS NOT NULL AND f.day IS NOT NULL AND s.day < f.day
       ORDER BY s.day DESC
       LIMIT 1
    ) pf ON true
    LEFT JOIN LATERAL (
      SELECT s.day, s.views FROM social_snapshots s
       WHERE s.account_id = a.id AND s.views IS NOT NULL
       ORDER BY s.day DESC
       LIMIT 1
    ) v ON true
    LEFT JOIN LATERAL (
      SELECT s.views FROM social_snapshots s
       WHERE s.account_id = a.id AND s.views IS NOT NULL AND v.day IS NOT NULL AND s.day < v.day
       ORDER BY s.day DESC
       LIMIT 1
    ) pv ON true
   ORDER BY a.platform, a.handle`;

const TREND_SQL = `
  SELECT account_id, day::text AS day, followers
    FROM (
      SELECT account_id, day, followers,
             row_number() OVER (PARTITION BY account_id ORDER BY day DESC) AS rn
        FROM social_snapshots
       WHERE followers IS NOT NULL
    ) t
   WHERE rn <= $1
   ORDER BY account_id, day`;

/**
 * Every account with its latest known followers and views (each with its own day), the change of each
 * against its previous known value, and the followers trend.
 */
export async function listAccounts(db: Queryable): Promise<AccountRow[]> {
  const { rows } = await db.query<RawAccount>(LIST_SQL);
  const trend = await db.query<{ account_id: string; followers: unknown }>(TREND_SQL, [TREND_POINTS]);
  const points = new Map<string, number[]>();
  for (const t of trend.rows) {
    const n = toCount(t.followers);
    if (n === null) continue;
    const list = points.get(t.account_id) ?? [];
    list.push(n);
    points.set(t.account_id, list);
  }
  return rows.map((r) => {
    const followers = toCount(r.followers);
    const views = toCount(r.views);
    const prevFollowers = toCount(r.prev_followers);
    const prevViews = toCount(r.prev_views);
    return {
      id: r.id,
      platform: r.platform,
      handle: r.handle,
      ingest: r.ingest,
      snapshots: toCount(r.snapshots) ?? 0,
      day: r.day,
      followers:
        r.followers_day !== null && followers !== null
          ? { value: followers, day: r.followers_day, exact: r.followers_exact !== false }
          : null,
      views: r.views_day !== null && views !== null ? { value: views, day: r.views_day } : null,
      change: {
        followers: followers !== null && prevFollowers !== null ? followers - prevFollowers : null,
        views: views !== null && prevViews !== null ? views - prevViews : null,
      },
      trend: points.get(r.id) ?? [],
    };
  });
}

// ---------------------------------------------------------------- pure helpers for the page and tests

/** The accounts of one source (all of them for "all"). */
export function inSource(rows: AccountRow[], source: Source): AccountRow[] {
  return source === "all" ? rows : rows.filter((r) => r.platform === source);
}

export interface Totals {
  /** Accounts in the list. */
  accounts: number;
  /** Sum of the latest known followers over the accounts that have one; null when none has one. */
  followers: number | null;
  /** Sum of the latest known views over the accounts that have one; null when none has one. */
  views: number | null;
}

/** Totals over the latest known value of each metric per account in `rows`. */
export function totalsFor(rows: AccountRow[]): Totals {
  const sum = (pick: (r: AccountRow) => number | null): number | null => {
    let total: number | null = null;
    for (const r of rows) {
      const v = pick(r);
      if (v !== null) total = (total ?? 0) + v;
    }
    return total;
  };
  return {
    accounts: rows.length,
    followers: sum((r) => r.followers?.value ?? null),
    views: sum((r) => r.views?.value ?? null),
  };
}
