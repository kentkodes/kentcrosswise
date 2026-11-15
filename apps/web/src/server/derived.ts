// Derived records (hub feature 2). When an entry gets its route, one row of that kind is created from the
// entry's text (crm_notes, diary_entries, todos, ideas). Reassignment moves the current body of the old
// row into a new row of the new kind. agent_request is a category only (no table). entries.raw_text is
// never changed. Runs inside the caller's transaction (web_rw); no model call and no other module is
// called here.
import type { RouteKind } from "./capture";
import type { Queryable } from "./db";

const TABLES = {
  crm_note: "crm_notes",
  diary: "diary_entries",
  todo: "todos",
  idea: "ideas",
} as const;
type DerivedKind = keyof typeof TABLES;

const hasTable = (k: RouteKind): k is DerivedKind => Object.hasOwn(TABLES, k);

/**
 * Applies a route change for one entry: `from` is the kind that currently has a derived row (null when
 * none: a new route, or an entry that was waiting for the owner), `to` the new kind. Removes the old
 * row after reading its body (the owner may have edited it), then creates the new row with that body
 * (the raw text when there was no old row). Returns what it created, or null when nothing was created
 * (agent_request, or the row already exists, so a retry makes no duplicate).
 */
export async function applyRoute(
  db: Queryable,
  entryId: string,
  from: RouteKind | null,
  to: RouteKind,
): Promise<{ kind: RouteKind; id: string } | null> {
  let moved: string | null = null;
  if (from !== null && from !== to && hasTable(from)) {
    const table = TABLES[from];
    const old = await db.query<{ body: string }>(`DELETE FROM ${table} WHERE entry_id = $1 RETURNING body`, [entryId]);
    moved = old.rows[0]?.body ?? null;
  }
  if (!hasTable(to)) return null;

  const table = TABLES[to];
  // diary_entries.written_at is the capture time; the other tables use their created_at default.
  const columns = to === "diary" ? "(entry_id, body, written_at)" : "(entry_id, body)";
  const values = to === "diary" ? "id, COALESCE($2, raw_text), created_at" : "id, COALESCE($2, raw_text)";
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO ${table} ${columns} SELECT ${values} FROM entries WHERE id = $1
       ON CONFLICT (entry_id) WHERE entry_id IS NOT NULL DO NOTHING RETURNING id`,
    [entryId, moved],
  );
  const created = rows[0];
  return created ? { kind: to, id: created.id } : null;
}
