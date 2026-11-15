import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addProject,
  deleteProject,
  essaySummary,
  ESSAYS_SLUG,
  listProjects,
  moveProject,
  parseProjectTitle,
  PROJECT_TITLE_MAX,
  renameProject,
  slugFromTitle,
} from "../src/server/projects";
import { runAs, type Queryable } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

/** The error code thrown by fn (fails the test when fn does not throw). */
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  throw new Error("expected a throw");
}

describe("slugFromTitle", () => {
  it("lower-cases, joins words with hyphens and trims hyphens at the ends", () => {
    expect(slugFromTitle("My Project")).toBe("my-project");
    expect(slugFromTitle("  Side--Project!! 2 ")).toBe("side-project-2");
    expect(slugFromTitle("***Notes***")).toBe("notes");
  });

  it("drops accents and keeps digits", () => {
    expect(slugFromTitle("Café Notes 2026")).toBe("cafe-notes-2026");
  });

  it("is empty when no letter or digit is left", () => {
    expect(slugFromTitle("!!! ---")).toBe("");
    expect(slugFromTitle("中文")).toBe("");
  });

  it("only ever produces the database's allowed characters", () => {
    for (const title of ["A/B\\C", "x_y.z", "Ünïcode Ç", "tab\tand\nnewline"]) {
      expect(slugFromTitle(title)).toMatch(/^[a-z0-9-]*$/);
    }
  });
});

describe("parseProjectTitle", () => {
  it("trims, refuses empty input and accepts exactly 80 characters", () => {
    expect(PROJECT_TITLE_MAX).toBe(80);
    expect(parseProjectTitle("  Garden  ")).toBe("Garden");
    expect(codeOf(() => parseProjectTitle("  "))).toBe("empty");
    expect(parseProjectTitle("x".repeat(80))).toBe("x".repeat(80));
    expect(codeOf(() => parseProjectTitle("x".repeat(81)))).toBe("too-long");
  });
});

describe("projects as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);
  const slugs = async () => (await asRw((db) => listProjects(db))).map((p) => p.slug);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("starts with the Essays tab from migration 0016", async () => {
    expect(await asRw((db) => listProjects(db))).toEqual([{ slug: "essays", title: "Essays", sort: 0 }]);
  });

  it("adds a project with a derived slug, last in the order", async () => {
    const slug = await asRw((db) => addProject(db, "Garden Log"));
    expect(slug).toBe("garden-log");
    const list = await asRw((db) => listProjects(db));
    expect(list.at(-1)).toEqual({ slug: "garden-log", title: "Garden Log", sort: 1 });
  });

  it("refuses a title whose slug already exists, and a title with no slug characters", async () => {
    await expect(asRw((db) => addProject(db, "Garden Log"))).rejects.toMatchObject({ code: "slug-taken" });
    await expect(asRw((db) => addProject(db, "garden-LOG!"))).rejects.toMatchObject({ code: "slug-taken" });
    await expect(asRw((db) => addProject(db, "Essays"))).rejects.toMatchObject({ code: "slug-taken" });
    await expect(asRw((db) => addProject(db, "!!!"))).rejects.toMatchObject({ code: "no-slug" });
    await expect(asRw((db) => addProject(db, "   "))).rejects.toMatchObject({ code: "empty" });
    expect(await slugs()).toEqual(["essays", "garden-log"]);
  });

  it("renames a project's title but keeps its slug", async () => {
    await asRw((db) => renameProject(db, "garden-log", "Garden Journal"));
    const row = (await asRw((db) => listProjects(db))).find((p) => p.slug === "garden-log");
    expect(row).toEqual({ slug: "garden-log", title: "Garden Journal", sort: 1 });
  });

  it("refuses to rename or delete Essays, and a missing project is not found", async () => {
    await expect(asRw((db) => renameProject(db, ESSAYS_SLUG, "Writing"))).rejects.toMatchObject({ code: "protected" });
    await expect(asRw((db) => deleteProject(db, ESSAYS_SLUG))).rejects.toMatchObject({ code: "protected" });
    await expect(asRw((db) => renameProject(db, "nope", "Nope"))).rejects.toMatchObject({ code: "not-found" });
    await expect(asRw((db) => deleteProject(db, "nope"))).rejects.toMatchObject({ code: "not-found" });
    expect(await slugs()).toEqual(["essays", "garden-log"]);
  });

  it("moves a project up and down and rewrites the order as 0..n-1", async () => {
    await asRw((db) => addProject(db, "Third one"));
    expect(await slugs()).toEqual(["essays", "garden-log", "third-one"]);
    await asRw((db) => moveProject(db, "third-one", "up"));
    expect(await slugs()).toEqual(["essays", "third-one", "garden-log"]);
    await asRw((db) => moveProject(db, "essays", "down"));
    expect(await slugs()).toEqual(["third-one", "essays", "garden-log"]);
    expect((await asRw((db) => listProjects(db))).map((p) => p.sort)).toEqual([0, 1, 2]);
  });

  it("does nothing when a project at the edge moves further out", async () => {
    await asRw((db) => moveProject(db, "third-one", "up"));
    expect(await slugs()).toEqual(["third-one", "essays", "garden-log"]);
    await asRw((db) => moveProject(db, "garden-log", "down"));
    expect(await slugs()).toEqual(["third-one", "essays", "garden-log"]);
  });

  it("repairs equal sort values when it moves, so the move is visible", async () => {
    // All sort values equal: the order is by title (Essays, Garden Journal, Third one), so garden-log is second.
    await pg.query("UPDATE projects SET sort = 7");
    await asRw((db) => moveProject(db, "garden-log", "up"));
    expect(await slugs()).toEqual(["garden-log", "essays", "third-one"]);
    expect((await asRw((db) => listProjects(db))).map((p) => p.sort)).toEqual([0, 1, 2]);
  });

  it("refuses a bad direction or a missing project for a move", async () => {
    await expect(asRw((db) => moveProject(db, "essays", "sideways"))).rejects.toMatchObject({ code: "invalid-direction" });
    await expect(asRw((db) => moveProject(db, "nope", "up"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("deletes a project and removes it from the list", async () => {
    await asRw((db) => deleteProject(db, "third-one"));
    expect(await slugs()).toEqual(["garden-log", "essays"]);
  });

  it("summarises the essays library: active essays and how many are rated", async () => {
    const { rows } = await pg.query<{ id: string }>(
      `INSERT INTO essays (kind, title, author, status, text_hash, text_s3_key) VALUES
         ('link', 'Essay one', 'Author A', 'active', NULL, NULL),
         ('link', 'Essay two', 'Author B', 'active', NULL, NULL),
         ('link', 'Quarantined', 'Author C', 'quarantined', NULL, NULL)
       RETURNING id`,
    );
    await pg.query("INSERT INTO ratings (essay_id, stars) VALUES ($1, 4)", [rows[0]!.id]);
    await pg.query("INSERT INTO ratings (essay_id, stars) VALUES ($1, 2)", [rows[2]!.id]);
    expect(await asRw((db) => essaySummary(db))).toEqual({ essays: 2, rated: 1 });
  });
});
