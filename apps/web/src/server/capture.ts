// Hub capture box (H2): raw entries as typed, and their routing status. Runs as web_rw. Owner pages only:
// entries hold private text and must never reach a public route. Routing itself is in router.ts.
import type { Tone } from "../app/(owner)/tones";
import type { Queryable } from "./db";

export const MAX_CAPTURE_CHARS = 10000;

export type CaptureError = "empty" | "too-long";
export type CaptureParse = { ok: true; text: string } | { ok: false; error: CaptureError };

/**
 * Checks a submitted capture. Text that is only whitespace counts as empty. The text is stored as
 * typed, except CRLF becomes LF (browsers submit textarea line breaks as CRLF). The length limit
 * counts the stored text.
 */
export function parseCapture(raw: unknown): CaptureParse {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, error: "empty" };
  const text = raw.replaceAll("\r\n", "\n");
  if (text.length > MAX_CAPTURE_CHARS) return { ok: false, error: "too-long" };
  return { ok: true, text };
}

export const ROUTE_LABELS = {
  crm_note: "CRM note",
  diary: "Diary",
  todo: "Todo",
  idea: "Idea",
  agent_request: "Agent request",
} as const;

export type RouteKind = keyof typeof ROUTE_LABELS;

/** Fixed codes for why the last routing attempt failed (never a provider message or text). */
export type RouteError = "provider_error" | "invalid_label" | "spend_cap";

export interface EntryRow {
  id: string;
  createdAt: string;
  rawText: string;
  routeKind: RouteKind | null;
  status: "routed" | "needs_owner" | null;
  routeError: RouteError | null;
  routeAttempts: number;
}

/**
 * The word and dot tone for an entry: "Needs you" (warn), a route label (ok), "Routing failed" or
 * "Routing paused: spend cap" (warn), or "Waiting for router" (idle).
 */
export function entryStatus(row: Pick<EntryRow, "routeKind" | "status"> & { routeError?: RouteError | null }): {
  label: string;
  tone: Tone;
} {
  if (row.status === "needs_owner") return { label: "Needs you", tone: "warn" };
  if (row.routeKind !== null) return { label: ROUTE_LABELS[row.routeKind], tone: "ok" };
  if (row.routeError === "spend_cap") return { label: "Routing paused: spend cap", tone: "warn" };
  if (row.routeError) return { label: "Routing failed", tone: "warn" };
  return { label: "Waiting for router", tone: "idle" };
}

/** Inserts a web entry with its raw text (route stays NULL, so it is pending) and returns its id. */
export async function saveEntry(db: Queryable, text: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', $1) RETURNING id", [text]);
  return rows[0]!.id;
}

interface DbEntry {
  id: string;
  created_at: Date | string;
  raw_text: string;
  route_kind: RouteKind | null;
  status: "routed" | "needs_owner" | null;
  route_error: RouteError | null;
  route_attempts: number;
}

const ENTRY_COLUMNS = "id, created_at, raw_text, route_kind, status, route_error, route_attempts";

const toEntryRow = (r: DbEntry): EntryRow => ({
  id: r.id,
  createdAt: new Date(r.created_at).toISOString(),
  rawText: r.raw_text,
  routeKind: r.route_kind,
  status: r.status,
  routeError: r.route_error,
  routeAttempts: Number(r.route_attempts),
});

/** The newest entries first. */
export async function listRecentEntries(db: Queryable, limit = 10): Promise<EntryRow[]> {
  const { rows } = await db.query<DbEntry>(`SELECT ${ENTRY_COLUMNS} FROM entries ORDER BY created_at DESC, id DESC LIMIT $1`, [limit]);
  return rows.map(toEntryRow);
}

/** Every entry that is still pending, failed, capped or waiting for the owner, oldest first (no limit). */
export async function listUnresolvedEntries(db: Queryable): Promise<EntryRow[]> {
  const { rows } = await db.query<DbEntry>(
    `SELECT ${ENTRY_COLUMNS} FROM entries WHERE route_kind IS NULL OR status = 'needs_owner' ORDER BY created_at, id`,
  );
  return rows.map(toEntryRow);
}
