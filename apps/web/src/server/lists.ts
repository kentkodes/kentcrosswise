// H7 lists: todos and ideas (owner pages /todos and /ideas). Runs as web_rw through withDb.
// Rows can come from a capture (entry_id set; the router creates those rows). Text is private: the
// functions here never log it, and errors carry only a code.
import type { Queryable } from "./db";

export const MAX_ITEM_CHARS = 2000;

export type ItemErrorCode = "empty" | "too-long" | "not-found" | "invalid-status";

/** A rejected input or a missing row. The message is the code only, so it never carries the text. */
export class ListInputError extends Error {
  override name = "ListInputError";
  constructor(public readonly code: ItemErrorCode) {
    super(code);
  }
}

export type ItemParse = { ok: true; text: string } | { ok: false; error: "empty" | "too-long" };

/** Trims the text; it must not be empty and must be at most MAX_ITEM_CHARS characters (code points). */
export function parseItemText(raw: unknown): ItemParse {
  if (typeof raw !== "string") return { ok: false, error: "empty" };
  const text = raw.trim();
  if (text === "") return { ok: false, error: "empty" };
  if (Array.from(text).length > MAX_ITEM_CHARS) return { ok: false, error: "too-long" };
  return { ok: true, text };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkId(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new ListInputError("not-found");
  return id;
}

function parseOrThrow(raw: unknown): string {
  const parsed = parseItemText(raw);
  if (!parsed.ok) throw new ListInputError(parsed.error);
  return parsed.text;
}

// ---------------------------------------------------------------- todos

export interface TodoRow {
  id: string;
  body: string;
  done: boolean;
  createdAt: string;
  fromCapture: boolean;
}

/** Open todos first, then done ones; each group oldest first. */
export async function listTodos(db: Queryable): Promise<TodoRow[]> {
  const { rows } = await db.query<{ id: string; body: string; done: boolean; created_at: Date | string; entry_id: string | null }>(
    "SELECT id, body, done, created_at, entry_id FROM todos ORDER BY done ASC, created_at ASC, id ASC",
  );
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    done: r.done,
    createdAt: new Date(r.created_at).toISOString(),
    fromCapture: r.entry_id !== null,
  }));
}

/** Adds an open todo typed by the owner (no entry). Returns its id. */
export async function addTodo(db: Queryable, raw: unknown): Promise<string> {
  const text = parseOrThrow(raw);
  const { rows } = await db.query<{ id: string }>("INSERT INTO todos (body) VALUES ($1) RETURNING id", [text]);
  return rows[0]!.id;
}

/** Marks a todo done (true) or open again (false). */
export async function setTodoDone(db: Queryable, id: unknown, done: boolean): Promise<void> {
  const { rows } = await db.query<{ id: string }>("UPDATE todos SET done = $2 WHERE id = $1 RETURNING id", [checkId(id), done]);
  if (rows.length === 0) throw new ListInputError("not-found");
}

export async function deleteTodo(db: Queryable, id: unknown): Promise<void> {
  const { rows } = await db.query<{ id: string }>("DELETE FROM todos WHERE id = $1 RETURNING id", [checkId(id)]);
  if (rows.length === 0) throw new ListInputError("not-found");
}

// ---------------------------------------------------------------- ideas

export const IDEA_STATUSES = ["open", "done", "dropped"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export interface IdeaRow {
  id: string;
  body: string;
  status: IdeaStatus;
  createdAt: string;
  fromCapture: boolean;
}

/** Newest first. */
export async function listIdeas(db: Queryable): Promise<IdeaRow[]> {
  const { rows } = await db.query<{
    id: string;
    body: string;
    status: IdeaStatus;
    created_at: Date | string;
    entry_id: string | null;
  }>("SELECT id, body, status, created_at, entry_id FROM ideas ORDER BY created_at DESC, id DESC");
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    fromCapture: r.entry_id !== null,
  }));
}

/** Adds an open idea typed by the owner (no entry). Returns its id. */
export async function addIdea(db: Queryable, raw: unknown): Promise<string> {
  const text = parseOrThrow(raw);
  const { rows } = await db.query<{ id: string }>("INSERT INTO ideas (body) VALUES ($1) RETURNING id", [text]);
  return rows[0]!.id;
}

export function isIdeaStatus(value: unknown): value is IdeaStatus {
  return typeof value === "string" && (IDEA_STATUSES as readonly string[]).includes(value);
}

export async function setIdeaStatus(db: Queryable, id: unknown, status: unknown): Promise<void> {
  if (!isIdeaStatus(status)) throw new ListInputError("invalid-status");
  const { rows } = await db.query<{ id: string }>("UPDATE ideas SET status = $2 WHERE id = $1 RETURNING id", [checkId(id), status]);
  if (rows.length === 0) throw new ListInputError("not-found");
}

export async function deleteIdea(db: Queryable, id: unknown): Promise<void> {
  const { rows } = await db.query<{ id: string }>("DELETE FROM ideas WHERE id = $1 RETURNING id", [checkId(id)]);
  if (rows.length === 0) throw new ListInputError("not-found");
}
