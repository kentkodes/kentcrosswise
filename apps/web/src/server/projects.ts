// H7 project tabs (owner page /projects). The projects table holds the tab strip: slug, title, sort.
// Runs as web_rw through withDb. Project titles are private text: nothing here logs them.
import type { Queryable } from "./db";

export const PROJECT_TITLE_MAX = 80;
/** The Essays tab: built in (migration 0016). It cannot be renamed or deleted. */
export const ESSAYS_SLUG = "essays";

export type ProjectErrorCode = "empty" | "too-long" | "no-slug" | "slug-taken" | "protected" | "not-found" | "invalid-direction";

export class ProjectInputError extends Error {
  override name = "ProjectInputError";
  constructor(public readonly code: ProjectErrorCode) {
    super(code);
  }
}

export interface ProjectRow {
  slug: string;
  title: string;
  sort: number;
}

/**
 * The slug for a title: lower case ASCII letters, digits and hyphens. Accents are dropped (Café -> cafe), any other
 * run of characters becomes one hyphen, and hyphens at either end are removed. Empty when nothing is left.
 */
export function slugFromTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Trims the title; it must not be empty and at most PROJECT_TITLE_MAX characters. */
export function parseProjectTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new ProjectInputError("empty");
  const title = raw.trim();
  if (title === "") throw new ProjectInputError("empty");
  if (Array.from(title).length > PROJECT_TITLE_MAX) throw new ProjectInputError("too-long");
  return title;
}

/** Ordered by sort, then title (slug last, so two equal titles still have a fixed order). */
export async function listProjects(db: Queryable): Promise<ProjectRow[]> {
  const { rows } = await db.query<{ slug: string; title: string; sort: number }>(
    "SELECT slug, title, sort FROM projects ORDER BY sort, title, slug",
  );
  return rows.map((r) => ({ slug: r.slug, title: r.title, sort: Number(r.sort) }));
}

/**
 * Adds a project. The slug is derived from the title; an existing slug is refused (no silent suffix), so a
 * title that derives to an existing slug (including "Essays") is a collision. The new project goes last.
 */
export async function addProject(db: Queryable, rawTitle: unknown): Promise<string> {
  const title = parseProjectTitle(rawTitle);
  const slug = slugFromTitle(title);
  if (slug === "") throw new ProjectInputError("no-slug");
  try {
    await db.query("INSERT INTO projects (slug, title, sort) SELECT $1, $2, COALESCE(MAX(sort), 0) + 1 FROM projects", [slug, title]);
  } catch (err) {
    // 23505: unique_violation on the primary key (the slug). The failed statement aborts the transaction; the
    // caller's transaction rolls back when this error leaves it.
    if ((err as { code?: unknown }).code === "23505") throw new ProjectInputError("slug-taken");
    throw err;
  }
  return slug;
}

/** Renames a project's title. The slug does not change, so ?tab= links stay valid. Essays cannot be renamed. */
export async function renameProject(db: Queryable, slug: string, rawTitle: unknown): Promise<void> {
  if (slug === ESSAYS_SLUG) throw new ProjectInputError("protected");
  const title = parseProjectTitle(rawTitle);
  const { rows } = await db.query<{ slug: string }>("UPDATE projects SET title = $2 WHERE slug = $1 RETURNING slug", [slug, title]);
  if (rows.length === 0) throw new ProjectInputError("not-found");
}

/** Deletes a project. Essays cannot be deleted. */
export async function deleteProject(db: Queryable, slug: string): Promise<void> {
  if (slug === ESSAYS_SLUG) throw new ProjectInputError("protected");
  const { rows } = await db.query<{ slug: string }>("DELETE FROM projects WHERE slug = $1 RETURNING slug", [slug]);
  if (rows.length === 0) throw new ProjectInputError("not-found");
}

/**
 * Moves a project one place up or down the tab order. The whole order is rewritten as 0..n-1, so equal or
 * gapped sort values are repaired by the move. Moving the first project up (or the last down) changes nothing.
 */
export async function moveProject(db: Queryable, slug: string, direction: unknown): Promise<void> {
  if (direction !== "up" && direction !== "down") throw new ProjectInputError("invalid-direction");
  const { rows } = await db.query<{ slug: string }>("SELECT slug FROM projects ORDER BY sort, title, slug");
  const order = rows.map((r) => r.slug);
  const at = order.indexOf(slug);
  if (at === -1) throw new ProjectInputError("not-found");
  const to = direction === "up" ? at - 1 : at + 1;
  if (to < 0 || to >= order.length) return;
  [order[at], order[to]] = [order[to]!, order[at]!];
  for (const [index, s] of order.entries()) {
    await db.query("UPDATE projects SET sort = $2 WHERE slug = $1", [s, index]);
  }
}

export interface EssaySummary {
  /** Essays in the library (active, as the library shows them). */
  essays: number;
  /** Of those, how many have a rating. */
  rated: number;
}

/** Read-only summary for the Essays tab, from the essays and ratings tables. */
export async function essaySummary(db: Queryable): Promise<EssaySummary> {
  const { rows } = await db.query<{ essays: number; rated: number }>(
    `SELECT count(*)::int AS essays, count(r.essay_id)::int AS rated
       FROM essays e LEFT JOIN ratings r ON r.essay_id = e.id
      WHERE e.status = 'active'`,
  );
  return { essays: rows[0]!.essays, rated: rows[0]!.rated };
}
