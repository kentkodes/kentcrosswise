import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ReleasesBlock } from "../src/app/(owner)/console/releases";
import { runAs, type Queryable } from "../src/server/db";
import { listReleases, loadReleases, releaseLabel, RELEASE_LIST_LIMIT } from "../src/server/releases";
import { freshDb, pglitePool } from "./pglite";

// AR8a owner releases block: labels, order and limit on PGlite as web_rw. Synthetic data only.
const sha = (c: string) => c.repeat(40);

describe("console releases as web_rw (PGlite)", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await pg.query("DELETE FROM task_releases");
  });

  /** A release merged `ago` minutes ago; the timestamps are minutes after the merge (null: unset). */
  async function release(s: string, ago: number, t: { deployed?: number; verified?: number; failed?: number; run?: number; build?: string } = {}) {
    const at = (m: number | undefined) => (m === undefined ? null : new Date(Date.now() - (ago - m) * 60_000).toISOString());
    await pg.query(
      `INSERT INTO task_releases (merge_sha, task_id, pr_number, merged_at, deploy_run_id, deploy_attempt, deploy_sha, build_id, deployed_at, verified_at, failed_at)
       VALUES ($1, 5, 9, $2, $3, 1, $4, $5, $6, $7, $8)`,
      [s, new Date(Date.now() - ago * 60_000).toISOString(), t.run ?? null, t.run ? s : null, t.build ?? null, at(t.deployed), at(t.verified), at(t.failed)],
    );
  }

  it("labels verified, deployed-not-verified, failed, young merged and missing", async () => {
    await release(sha("a"), 300, { run: 11, deployed: 8, verified: 10, build: "build-1" });
    await release(sha("b"), 200, { run: 12, deployed: 8 });
    await release(sha("c"), 100, { run: 13, deployed: 8, failed: 10 }); // failed at the smoke check
    await release(sha("d"), 30);
    await release(sha("e"), 90);
    const rows = await asRw((db) => listReleases(db));
    expect(Object.fromEntries(rows.map((r) => [r.shortSha, r.label]))).toEqual({
      aaaaaaa: "verified",
      bbbbbbb: "deployed",
      ccccccc: "failed",
      ddddddd: "merged",
      eeeeeee: "missing",
    });
    expect(rows.map((r) => r.shortSha)).toEqual(["ddddddd", "eeeeeee", "ccccccc", "bbbbbbb", "aaaaaaa"]); // newest merge first
    expect(rows.find((r) => r.shortSha === "aaaaaaa")).toMatchObject({ runId: 11, buildId: "build-1", taskId: 5, prNumber: 9 });
  });

  it("returns at most the last 10", async () => {
    for (let i = 0; i < 12; i++) await release(i.toString(16).padStart(40, "0"), 10 + i);
    expect(await asRw((db) => listReleases(db))).toHaveLength(RELEASE_LIST_LIMIT);
  });

  it("derives missing from the merge time only at 60 minutes", () => {
    const now = new Date("2026-11-16T12:00:00Z");
    const base = { deployedAt: null, verifiedAt: null, failedAt: null };
    expect(releaseLabel({ ...base, mergedAt: "2026-11-16T11:01:00Z" }, now)).toBe("merged");
    expect(releaseLabel({ ...base, mergedAt: "2026-11-16T10:59:00Z" }, now)).toBe("missing");
  });

  it("renders the text labels and the run link, and no private text", async () => {
    await pg.query("DELETE FROM tasks");
    await pg.query("INSERT INTO tasks (source, owner_text, status) VALUES ('console', 'PRIVATE-OWNER-TEXT', 'done')");
    await release(sha("a"), 300, { run: 11, deployed: 8, verified: 10, build: "build-1" });
    await release(sha("c"), 100, { run: 13, deployed: 8, failed: 10 });
    await release(sha("d"), 30);
    await release(sha("e"), 90);
    await release(sha("b"), 200, { run: 12, deployed: 8 });
    const html = renderToStaticMarkup(createElement(ReleasesBlock, { releases: await asRw((db) => listReleases(db)) }));
    for (const label of ["Merged", "Deployed, not verified", "Verified", "Deploy failed", "No deploy result"]) expect(html).toContain(`>${label}<`);
    expect(html).toContain('href="https://github.com/kentkodes/kentcrosswise/actions/runs/11"');
    expect(html).toContain("build-1");
    expect(html).not.toContain("PRIVATE-OWNER-TEXT");
  });

  it("a failing releases read gives a fixed unavailable text and leaves the transaction usable", async () => {
    await release(sha("a"), 30);
    const out = await asRw(async (db) => {
      const broken: Queryable = {
        query: ((sql: string, params?: unknown[]) =>
          /FROM task_releases/.test(sql) ? Promise.reject(new Error("secret detail")) : db.query(sql, params)) as Queryable["query"],
      };
      const r = await loadReleases(broken);
      const after = await db.query("SELECT 1 AS one");
      return { r, after: after.rows };
    });
    expect(out.r).toEqual({ releases: [], unavailable: true });
    expect(out.after).toEqual([{ one: 1 }]);
    const html = renderToStaticMarkup(createElement(ReleasesBlock, { releases: [], unavailable: true }));
    expect(html).toContain("Release state is unavailable right now.");
    expect(html).not.toContain("secret detail");
    expect(await asRw((db) => loadReleases(db))).toMatchObject({ unavailable: false });
  });

  it("web_rw cannot write task_releases", async () => {
    await expect(asRw((db) => db.query("UPDATE task_releases SET checked_at = now()"))).rejects.toThrow(/permission denied/);
  });
});
