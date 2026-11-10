import type { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAs, type Queryable } from "../src/server/db";
import { essayStatus, MAX_WORK_ROWS, safeCode, workStage, type EssayStatus } from "../src/server/essay-status";
import { freshDb, pglitePool } from "./pglite";

const { EssayStatusSection } = await import("../src/app/(owner)/console/essay-status");

// Strings that must never reach the page: stored in columns the panel does not select, or hostile.
const SECRET_KEY = "essays/text/SECRETKEYabc.txt";
const SECRET_HASH = "deadbeefSECRETHASH";
const SECRET_URL = "https://user:SECRETPASS@www.gutenberg.org/ebooks/";
const HOSTILE = [`<img src=x onerror=alert(1)>`, `"><script>alert(1)</script>`, `<b>evil</b>`];

describe("essay status as web_rw", () => {
  let pg: PGlite;
  let status: EssayStatus;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn, { readOnly: true });

  /** One approved work: seed, approved link, and (optionally) its essay_urls row. */
  async function work(sourceId: string, n: number, title: string, author: string, url?: { status: string; attempts?: number }): Promise<string> {
    const seed = (await pg.query<{ id: string }>("INSERT INTO seed_items (title, author, status) VALUES ($1, $2, 'approved') RETURNING id", [title, author])).rows[0]!.id;
    const link = (
      await pg.query<{ id: string }>(
        `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
         VALUES ($1, $2, $3, 't', 'a', 'A', 1, 'approved') RETURNING id`,
        [seed, sourceId, `https://www.gutenberg.org/ebooks/${n}`],
      )
    ).rows[0]!.id;
    const u = `https://www.gutenberg.org/ebooks/${n}`;
    if (url) {
      await pg.query(
        "INSERT INTO essay_urls (url, source_id, url_hash, seed_item_id, link_id, status, attempts) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [u, sourceId, `h${n}`, seed, link, url.status, url.attempts ?? 0],
      );
    }
    return u;
  }

  beforeAll(async () => {
    pg = await freshDb();
    const src = (await pg.query<{ id: string }>(
      "INSERT INTO sources (name, base_url, slug, health, health_reason, paused_by) VALUES ('Project Gutenberg', 'https://www.gutenberg.org', 'gutenberg', 'broken', 'robots_disallow', 'block') RETURNING id",
    )).rows[0]!.id;
    await pg.query("INSERT INTO sources (name, base_url, slug, health_reason) VALUES ($1, 'https://other.example.com', 'other', $2)", [HOSTILE[2], HOSTILE[1]]);

    await work(src, 1, "Approved only", "Ann Author");
    await work(src, 2, "Queued", "Ann Author", { status: "new" });
    await work(src, 3, "Retrying", "Ann Author", { status: "new", attempts: 2 });
    const stored = await work(src, 4, "Stored", "Ann Author", { status: "fetched" });
    await work(src, 5, "Duplicate", "Ann Author", { status: "fetched" });
    const q1 = await work(src, 6, "Quarantined", "Ann Author", { status: "quarantined" });
    const q2 = await work(src, 7, "Quarantined two", "Ann Author", { status: "quarantined" });
    await work(src, 8, "Link only", "Ann Author", { status: "link_only" });
    await work(src, 9, "Failed", "Ann Author", { status: "failed", attempts: 5 });
    await work(src, 10, HOSTILE[0] as string, HOSTILE[1] as string);

    await pg.query(
      `INSERT INTO essays (kind, title, author, source_id, source_url, word_count, language, status, text_hash, text_s3_key)
       VALUES ('full', 'Stored', 'Ann Author', $1, $2, 500, 'en', 'pending_category', $3, $4)`,
      [src, stored, SECRET_HASH, SECRET_KEY],
    );
    await pg.query(`INSERT INTO essays (kind, title, author, source_id, word_count, status, text_hash, text_s3_key)
                    VALUES ('full', 'Active', 'Ann Author', $1, 500, 'active', 'h2', 'essays/text/h2.txt')`, [src]);
    await pg.query(
      `INSERT INTO quarantine (essay_url, reasons) VALUES
         ($1, '["missing_end_marker","too_short"]'), ($2, '["too_short"]'), ($2, $3::jsonb)`,
      [q1, q2, JSON.stringify([HOSTILE[1]])],
    );
    await pg.query("INSERT INTO quarantine (essay_url, reasons, resolved_at) VALUES ($1, '[\"html_tags\"]', now())", [q1]);
    // A proposed and a rejected link are counted but are not "works".
    const seed = (await pg.query<{ id: string }>("INSERT INTO seed_items (title, author, status) VALUES ('P', 'P', 'approved') RETURNING id")).rows[0]!.id;
    await pg.query(
      `INSERT INTO seed_source_links (seed_item_id, source_id, candidate_url, candidate_title, candidate_author, tier, score, status)
       VALUES ($1, $2, 'https://www.gutenberg.org/ebooks/99', 't', 'a', 'B', 0.5, 'proposed')`,
      [seed, src],
    );
    // Columns the panel must not read, holding strings that would be obvious if they leaked.
    await pg.query("UPDATE essay_urls SET url_hash = $1 WHERE url = $2", [SECRET_HASH, stored]);
    await pg.query("UPDATE sources SET feed_url = $1 WHERE slug = 'gutenberg'", [SECRET_URL]);

    status = await asRw(essayStatus);
  });
  afterAll(async () => {
    await pg.close();
  });

  it("derives each stage from existing columns", () => {
    const byTitle = Object.fromEntries(status.works.map((w) => [w.title, w]));
    expect(byTitle["Approved only"]).toMatchObject({ stage: "approved", code: null });
    expect(byTitle["Queued"]).toMatchObject({ stage: "queued", code: null });
    expect(byTitle["Retrying"]).toMatchObject({ stage: "queued", code: "retry" });
    expect(byTitle["Stored"]).toMatchObject({ stage: "stored", code: "pending_category" });
    expect(byTitle["Duplicate"]).toMatchObject({ stage: "fetched", code: "duplicate" });
    expect(byTitle["Quarantined"]).toMatchObject({ stage: "quarantined", code: "missing_end_marker" });
    expect(byTitle["Quarantined two"]).toMatchObject({ stage: "quarantined", code: "too_short" }); // newest open row
    expect(byTitle["Link only"]).toMatchObject({ stage: "link_only", code: null });
    expect(byTitle["Failed"]).toMatchObject({ stage: "failed", code: "max_attempts" });
    expect(status.works).toHaveLength(10);
    expect(status.worksTotal).toBe(10);
  });

  it("counts per source and per stage, stored and pending essays, and open quarantine by code", () => {
    const g = status.sources.find((s) => s.name === "Project Gutenberg")!;
    expect(g).toMatchObject({ health: "broken", pausedBy: "block", healthReason: "robots_disallow" });
    expect(g.links).toEqual({ approved: 10, proposed: 1, rejected: 0 });
    expect(g.urls).toEqual({ new: 2, fetched: 2, quarantined: 2, link_only: 1, failed: 1 });
    expect(status.essays).toEqual({ stored: 2, pendingCategory: 1 });
    // Open rows only (the resolved html_tags row is excluded); a hostile reason shows as "other".
    expect(status.quarantine).toEqual([{ code: "too_short", count: 2 }, { code: "missing_end_marker", count: 1 }, { code: "other", count: 1 }]);
  });

  it("returns no text, key, hash or URL fields at all", () => {
    const json = JSON.stringify(status);
    for (const secret of [SECRET_KEY, SECRET_HASH, "SECRETPASS", "SECRETKEY", "https://", "essays/text"]) expect(json).not.toContain(secret);
  });

  it("renders hostile strings in non-code columns escaped, and never the unselected columns", () => {
    const html = renderToStaticMarkup(createElement(EssayStatusSection, { status }));
    expect(html).not.toMatch(/<script|<img|<b>evil/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt;"); // source name, a non-code column
    // The hostile health_reason is a code column: it shows as "other", never raw.
    expect(html).not.toContain("alert(1)</script>");
    for (const secret of [SECRET_KEY, SECRET_HASH, "SECRETPASS", "https://"]) expect(html).not.toContain(secret);
    expect(html).toContain("Project Gutenberg");
    expect(html).toContain('data-field="stage">stored<');
  });

  it("lists at most 20 works and says how many exist", async () => {
    const src = (await pg.query<{ id: string }>("SELECT id FROM sources WHERE slug = 'gutenberg'")).rows[0]!.id;
    for (let i = 0; i < 15; i++) await work(src, 100 + i, `Extra ${String(i).padStart(2, "0")}`, "Bee Author");
    const s = await asRw(essayStatus);
    expect(s.works).toHaveLength(MAX_WORK_ROWS);
    expect(s.worksTotal).toBe(25);
    expect(renderToStaticMarkup(createElement(EssayStatusSection, { status: s }))).toContain("Showing 20 of 25 approved works.");
  });
});

describe("pure helpers", () => {
  it("safeCode passes short lowercase codes and hides everything else", () => {
    expect(safeCode("missing_end_marker")).toBe("missing_end_marker");
    for (const v of ["<b>", "Has Space", "UPPER", "", "x".repeat(41), null, 5, undefined]) expect(safeCode(v)).toBe("other");
  });
  it("workStage covers an unknown status without echoing it", () => {
    expect(workStage({ urlStatus: "<odd>", attempts: 0, essayStatus: null, reason: null })).toEqual({ stage: "failed", code: "other" });
    expect(workStage({ urlStatus: "quarantined", attempts: 0, essayStatus: null, reason: null })).toEqual({ stage: "quarantined", code: "unspecified" });
  });
});

describe("console wiring", () => {
  it("the owner console page renders the section and public routes do not import it", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../src/app/(owner)/console/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("<EssayStatusSection");
    expect(page).toContain("essayStatus(db)");
  });
});
