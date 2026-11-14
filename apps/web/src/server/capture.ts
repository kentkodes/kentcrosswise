// Hub capture box (H2): raw entries as typed, and their routing status. Runs as web_rw. Owner pages only:
// entries hold private text and must never reach a public route. Routing itself is H3; until then every
// entry shows "Waiting for router".
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

export interface EntryRow {
  id: string;
  createdAt: string;
  rawText: string;
  routeKind: RouteKind | null;
  status: "routed" | "needs_owner" | null;
}

/** The word and dot tone for an entry: "Needs you" (warn), a route label (ok) or "Waiting for router" (idle). */
export function entryStatus(row: Pick<EntryRow, "routeKind" | "status">): { label: string; tone: Tone } {
  if (row.status === "needs_owner") return { label: "Needs you", tone: "warn" };
  if (row.routeKind !== null) return { label: ROUTE_LABELS[row.routeKind], tone: "ok" };
  return { label: "Waiting for router", tone: "idle" };
}

/** Inserts a web entry with its raw text (route stays NULL, so it is pending) and returns its id. */
export async function saveEntry(db: Queryable, text: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("INSERT INTO entries (source, raw_text) VALUES ('web', $1) RETURNING id", [text]);
  return rows[0]!.id;
}

/** The newest entries first. */
export async function listRecentEntries(db: Queryable, limit = 10): Promise<EntryRow[]> {
  const { rows } = await db.query<{
    id: string;
    created_at: Date | string;
    raw_text: string;
    route_kind: RouteKind | null;
    status: "routed" | "needs_owner" | null;
  }>("SELECT id, created_at, raw_text, route_kind, status FROM entries ORDER BY created_at DESC, id DESC LIMIT $1", [limit]);
  return rows.map((r) => ({
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    rawText: r.raw_text,
    routeKind: r.route_kind,
    status: r.status,
  }));
}
