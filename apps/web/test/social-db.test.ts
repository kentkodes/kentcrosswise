import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAs, type Queryable } from "../src/server/db";
import {
  addAccount,
  deleteAccount,
  inSource,
  listAccounts,
  SocialInputError,
  TREND_POINTS,
  totalsFor,
  upsertSnapshot,
  type AccountRow,
} from "../src/server/social";
import { freshDb, pglitePool } from "./pglite";

const DAYS = { d1: "2026-11-10", d2: "2026-11-11", d3: "2026-11-12", d4: "2026-11-13" } as const;

describe("social tables as web_rw (PGlite)", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);

  let ids: { yt: string; ig: string; tt: string };

  beforeAll(async () => {
    pg = await freshDb();
    ids = {
      yt: await asRw((db) => addAccount(db, { platform: "youtube", handle: "@test_yt_channel" })),
      ig: await asRw((db) => addAccount(db, { platform: "instagram", handle: "test.ig.account" })),
      tt: await asRw((db) => addAccount(db, { platform: "tiktok", handle: "test_tt_profile" })),
    };
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });

  it("stores a manual account with ingest manual and a trimmed handle", async () => {
    const { rows } = await pg.query<{ handle: string; ingest: string }>("SELECT handle, ingest FROM social_accounts WHERE id = $1", [ids.yt]);
    expect(rows).toEqual([{ handle: "test_yt_channel", ingest: "manual" }]);
  });

  it("treats handles that differ only by case as the same account", async () => {
    await asRw((db) => addAccount(db, { platform: "tiktok", handle: "Probe_Case" }));
    const { rows } = await pg.query<{ handle: string }>("SELECT handle FROM social_accounts WHERE platform = 'tiktok' AND handle = 'probe_case'");
    expect(rows).toEqual([{ handle: "probe_case" }]);
    await expect(asRw((db) => addAccount(db, { platform: "tiktok", handle: "probe_case" }))).rejects.toMatchObject({
      code: "duplicate",
    });
    await expect(asRw((db) => addAccount(db, { platform: "tiktok", handle: "@PROBE_case" }))).rejects.toMatchObject({
      code: "duplicate",
    });
  });

  it("rejects the same platform and handle twice, and an invalid platform", async () => {
    await expect(asRw((db) => addAccount(db, { platform: "youtube", handle: "test_yt_channel" }))).rejects.toMatchObject({
      code: "duplicate",
    });
    await expect(asRw((db) => addAccount(db, { platform: "myspace" as never, handle: "x" }))).rejects.toBeInstanceOf(SocialInputError);
  });

  it("upsert writes a day, and a second save for the same day replaces every number", async () => {
    await asRw((db) =>
      upsertSnapshot(db, { accountId: ids.yt, day: DAYS.d1, followers: 1000, views: 5000, followersExact: true }),
    );
    await asRw((db) =>
      upsertSnapshot(db, { accountId: ids.yt, day: DAYS.d1, followers: 1100, views: null, followersExact: false }),
    );
    const { rows } = await pg.query<{ n: number; followers: string; views: string | null; followers_exact: boolean }>(
      "SELECT count(*)::int AS n, max(followers)::text AS followers, max(views)::text AS views, bool_and(followers_exact) AS followers_exact FROM social_snapshots WHERE account_id = $1 AND day = $2",
      [ids.yt, DAYS.d1],
    );
    // One row for the day, the new numbers, and the cleared views (null), not the old 5000.
    expect(rows).toEqual([{ n: 1, followers: "1100", views: null, followers_exact: false }]);
  });

  it("refuses a snapshot for an account that does not exist, as an account error", async () => {
    await expect(
      asRw((db) =>
        upsertSnapshot(db, {
          accountId: "00000000-0000-4000-8000-000000000000",
          day: DAYS.d1,
          followers: 1,
          views: null,
          followersExact: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "account" });
  });

  it("refuses a future day and an entry with no numbers before it reaches the table", async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await expect(
      asRw((db) => upsertSnapshot(db, { accountId: ids.ig, day: tomorrow, followers: 1, views: null, followersExact: true })),
    ).rejects.toMatchObject({ code: "day" });
    await expect(
      asRw((db) => upsertSnapshot(db, { accountId: ids.ig, day: DAYS.d1, followers: null, views: null, followersExact: true })),
    ).rejects.toMatchObject({ code: "empty" });
    const { rows } = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM social_snapshots WHERE account_id = $1", [ids.ig]);
    expect(rows[0]!.n).toBe(0);
  });

  it("totals use the latest snapshot of each account, and change is against the previous day", async () => {
    // youtube: d1 1100 / no views, d2 1250 / 9000 (latest d2), d3 nothing.
    await asRw((db) => upsertSnapshot(db, { accountId: ids.yt, day: DAYS.d2, followers: 1250, views: 9000, followersExact: true }));
    // instagram: only d3 (no earlier day, so no change). Rounded followers, no views.
    await asRw((db) => upsertSnapshot(db, { accountId: ids.ig, day: DAYS.d3, followers: 300, views: null, followersExact: false }));
    // tiktok: d2 then d4, both views and followers.
    await asRw((db) => upsertSnapshot(db, { accountId: ids.tt, day: DAYS.d2, followers: 50, views: 400, followersExact: true }));
    await asRw((db) => upsertSnapshot(db, { accountId: ids.tt, day: DAYS.d4, followers: 45, views: 700, followersExact: true }));
    // A day earlier than the latest added after the fact must not change the latest or the change.
    await asRw((db) => upsertSnapshot(db, { accountId: ids.tt, day: "2026-11-01", followers: 999, views: 999, followersExact: true }));

    const rows = await asRw((db) => listAccounts(db));
    const yt = idOf(rows, "test_yt_channel");
    const ig = idOf(rows, "test.ig.account");
    const tt = idOf(rows, "test_tt_profile");

    expect(yt.day).toBe(DAYS.d2);
    expect(yt.followers).toEqual({ value: 1250, day: DAYS.d2, exact: true });
    expect(yt.views).toEqual({ value: 9000, day: DAYS.d2 });
    expect(yt.change).toEqual({ followers: 150, views: null }); // d1 had no views, so no views change
    expect(ig.day).toBe(DAYS.d3);
    expect(ig.followers).toEqual({ value: 300, day: DAYS.d3, exact: false });
    expect(ig.views).toBeNull();
    expect(ig.change).toEqual({ followers: null, views: null });
    expect(tt.day).toBe(DAYS.d4);
    expect(tt.followers).toEqual({ value: 45, day: DAYS.d4, exact: true });
    expect(tt.views).toEqual({ value: 700, day: DAYS.d4 });
    expect(tt.change).toEqual({ followers: -5, views: 300 });

    const mine = [yt, ig, tt];
    expect(totalsFor(mine)).toEqual({ accounts: 3, followers: 1250 + 300 + 45, views: 9000 + 700 });
    // The account with no views on its latest day does not add to the views total.
    expect(totalsFor([ig])).toEqual({ accounts: 1, followers: 300, views: null });
  });

  it("the source filter keeps one platform's accounts, and its totals follow", async () => {
    const rows = await asRw((db) => listAccounts(db));
    const mine = rows.filter((r) => r.handle.startsWith("test"));
    expect(inSource(mine, "instagram").map((r) => r.handle)).toEqual(["test.ig.account"]);
    expect(totalsFor(inSource(mine, "tiktok"))).toEqual({ accounts: 1, followers: 45, views: 700 });
    expect(totalsFor(inSource(mine, "youtube"))).toEqual({ accounts: 1, followers: 1250, views: 9000 });
  });

  it("the trend lists the newest days with followers, oldest first, and skips days without followers", async () => {
    const rows = await asRw((db) => listAccounts(db));
    // youtube has d1 (1100), d2 (1250): two points.
    expect(idOf(rows, "test_yt_channel").trend).toEqual([1100, 1250]);
    // tiktok has 2026-11-01 (999), d2 (50), d4 (45): three points, oldest first.
    expect(idOf(rows, "test_tt_profile").trend).toEqual([999, 50, 45]);
  });

  it("the trend is capped at the newest TREND_POINTS days", async () => {
    const id = await asRw((db) => addAccount(db, { platform: "youtube", handle: "test_long_history" }));
    for (let i = 0; i < TREND_POINTS + 2; i++) {
      const day = new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      await asRw((db) => upsertSnapshot(db, { accountId: id, day, followers: 1000 + i, views: null, followersExact: true }));
    }
    const rows = await asRw((db) => listAccounts(db));
    const long = idOf(rows, "test_long_history");
    expect(long.trend).toHaveLength(TREND_POINTS);
    expect(long.trend[0]).toBe(1000 + 2);
    expect(long.trend.at(-1)).toBe(1000 + TREND_POINTS + 1);
    expect(long.snapshots).toBe(TREND_POINTS + 2);
  });

  it("an account API ingestion will write (ingest api) reads back as api, and an account with no snapshots has no latest", async () => {
    await pg.query("INSERT INTO social_accounts (platform, handle, ingest) VALUES ('tiktok', 'test_api_feed', 'api')");
    const rows = await asRw((db) => listAccounts(db));
    expect(idOf(rows, "test_api_feed")).toMatchObject({
      ingest: "api",
      day: null,
      followers: null,
      views: null,
      trend: [],
      snapshots: 0,
    });
  });

  it("deleting an account removes its snapshots through the foreign key, and leaves other accounts alone", async () => {
    const before = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM social_snapshots WHERE account_id = $1", [ids.tt]);
    expect(before.rows[0]!.n).toBeGreaterThan(0);

    expect(await asRw((db) => deleteAccount(db, ids.tt))).toBe(true);
    const gone = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM social_snapshots WHERE account_id = $1", [ids.tt]);
    expect(gone.rows[0]!.n).toBe(0);
    const kept = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM social_snapshots WHERE account_id = $1", [ids.yt]);
    expect(kept.rows[0]!.n).toBe(2);

    expect(await asRw((db) => deleteAccount(db, ids.tt))).toBe(false);
    await expect(asRw((db) => deleteAccount(db, "not-a-uuid"))).rejects.toMatchObject({ code: "account" });
  });

  it("uses the latest known value of each metric: an empty newer day keeps the older number and its day", async () => {
    const id = await asRw((db) => addAccount(db, { platform: "instagram", handle: "test_gap_metric" }));
    // Day 1: followers 500 and views 10. Day 2: followers left empty, views 20.
    await asRw((db) => upsertSnapshot(db, { accountId: id, day: DAYS.d1, followers: 500, views: 10, followersExact: true }));
    await asRw((db) => upsertSnapshot(db, { accountId: id, day: DAYS.d2, followers: null, views: 20, followersExact: true }));

    const first = idOf(await asRw((db) => listAccounts(db)), "test_gap_metric");
    expect(first.day).toBe(DAYS.d2); // the row's day is the newest snapshot
    expect(first.followers).toEqual({ value: 500, day: DAYS.d1, exact: true }); // older day, still the latest followers
    expect(first.views).toEqual({ value: 20, day: DAYS.d2 });
    expect(first.change).toEqual({ followers: null, views: 10 }); // one known followers value: no change yet

    // The totals count the 500 from day 1 (its account is the only one in this source's rows here).
    expect(totalsFor([first])).toEqual({ accounts: 1, followers: 500, views: 20 });

    // Day 3 brings 520 followers: the change compares it with the last two known followers values (500).
    await asRw((db) => upsertSnapshot(db, { accountId: id, day: "2026-11-14", followers: 520, views: null, followersExact: false }));
    const third = idOf(await asRw((db) => listAccounts(db)), "test_gap_metric");
    expect(third.followers).toEqual({ value: 520, day: "2026-11-14", exact: false });
    expect(third.change.followers).toBe(20);
    expect(third.views).toEqual({ value: 20, day: DAYS.d2 });
    expect(third.change.views).toBe(10);
  });
});

describe("bigint columns from node-postgres (strings) read the same as PGlite (numbers)", () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = await freshDb();
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });

  it("listAccounts gives identical results when the driver returns int8 as strings", async () => {
    const id = await runAs(pglitePool(pg), "web_rw", (db) => addAccount(db, { platform: "instagram", handle: "test_string_driver" }));
    await runAs(pglitePool(pg), "web_rw", (db) =>
      upsertSnapshot(db, { accountId: id, day: DAYS.d1, followers: 77, views: 12345, followersExact: true }),
    );
    await runAs(pglitePool(pg), "web_rw", (db) =>
      upsertSnapshot(db, { accountId: id, day: DAYS.d2, followers: 80, views: 12400, followersExact: true }),
    );

    const asNumbers = await runAs(pglitePool(pg), "web_rw", (db) => listAccounts(db));

    // Wrap the same session so every int8 comes back as a string, the way node-postgres returns it.
    const stringy: Queryable = {
      query: async <R>(sql: string, params?: readonly unknown[]) => {
        const res = await pg.query(sql, params ? [...params] : undefined);
        const rows = res.rows.map((r) => {
          const out: Record<string, unknown> = { ...(r as Record<string, unknown>) };
          for (const k of ["followers", "views", "prev_followers", "prev_views"]) {
            if (typeof out[k] === "number") out[k] = String(out[k]);
          }
          return out;
        });
        return { rows: rows as R[] };
      },
    };
    const asStrings = await listAccounts(stringy);

    expect(asStrings).toEqual(asNumbers);
    const row = idOf(asStrings, "test_string_driver");
    expect(row.followers).toEqual({ value: 80, day: DAYS.d2, exact: true });
    expect(row.views).toEqual({ value: 12400, day: DAYS.d2 });
    expect(idOf(asStrings, "test_string_driver").change).toEqual({ followers: 3, views: 55 });
  });
});

describe("ingest choice on addAccount (PGlite)", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);
  // The selection the daily job makes (apps/web/src/server/jobs/social-daily.ts), copied verbatim.
  const DAILY_JOB_SELECT = `SELECT DISTINCT ON (platform) platform, id FROM social_accounts
        WHERE ingest = 'api' AND platform IN ('youtube', 'instagram') ORDER BY platform, handle`;

  beforeAll(async () => {
    pg = await freshDb();
  }, 60_000);
  afterAll(async () => {
    await pg.close();
  });

  const ingestOf = async (handle: string) =>
    (await pg.query<{ ingest: string }>("SELECT ingest FROM social_accounts WHERE handle = $1", [handle])).rows;

  it("stores manual by default, and api when asked", async () => {
    await asRw((db) => addAccount(db, { platform: "tiktok", handle: "ingest_default" }));
    await asRw((db) => addAccount(db, { platform: "youtube", handle: "ingest_yt_api", ingest: "api" }));
    expect(await ingestOf("ingest_default")).toEqual([{ ingest: "manual" }]);
    expect(await ingestOf("ingest_yt_api")).toEqual([{ ingest: "api" }]);
  });

  it("refuses api for TikTok with its notice, and stores nothing", async () => {
    await expect(asRw((db) => addAccount(db, { platform: "tiktok", handle: "ingest_tt_api", ingest: "api" }))).rejects.toMatchObject({
      code: "api-tiktok",
    });
    expect(await ingestOf("ingest_tt_api")).toEqual([]);
  });

  it("refuses a second api account for the same platform, and accepts a second manual one", async () => {
    await expect(asRw((db) => addAccount(db, { platform: "youtube", handle: "ingest_yt_second", ingest: "api" }))).rejects.toMatchObject({
      code: "api-taken-youtube",
    });
    expect(await ingestOf("ingest_yt_second")).toEqual([]);
    await asRw((db) => addAccount(db, { platform: "youtube", handle: "ingest_yt_manual_two", ingest: "manual" }));
    await asRw((db) => addAccount(db, { platform: "youtube", handle: "ingest_yt_manual_three" }));
    expect(await ingestOf("ingest_yt_manual_two")).toEqual([{ ingest: "manual" }]);
  });

  it("allows one api YouTube and one api Instagram account together, and names the Instagram notice when refused", async () => {
    await asRw((db) => addAccount(db, { platform: "instagram", handle: "ingest_ig_api", ingest: "api" }));
    expect(await ingestOf("ingest_ig_api")).toEqual([{ ingest: "api" }]);
    await expect(asRw((db) => addAccount(db, { platform: "instagram", handle: "ingest_ig_second", ingest: "api" }))).rejects.toMatchObject({
      code: "api-taken-instagram",
    });
    const api = await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM social_accounts WHERE ingest = 'api' AND platform IN ('youtube', 'instagram')");
    expect(api.rows).toEqual([{ n: 2 }]);
  });

  it("refuses an ingest value that is neither manual nor api, as an ingest error", async () => {
    await expect(asRw((db) => addAccount(db, { platform: "youtube", handle: "ingest_bad", ingest: "auto" as never }))).rejects.toMatchObject({
      code: "ingest",
    });
    expect(await ingestOf("ingest_bad")).toEqual([]);
  });

  it("the row the daily job selects is the api account created through addAccount", async () => {
    const { rows } = await pg.query<{ platform: string; id: string }>(DAILY_JOB_SELECT);
    const created = await pg.query<{ platform: string; id: string }>(
      "SELECT platform, id FROM social_accounts WHERE handle IN ('ingest_yt_api', 'ingest_ig_api') ORDER BY platform",
    );
    expect(rows).toEqual(created.rows);
    expect(rows.map((r) => r.platform)).toEqual(["instagram", "youtube"]);
  });
});

function idOf(rows: AccountRow[], handle: string): AccountRow {
  const row = rows.find((r) => r.handle === handle);
  if (!row) throw new Error("account missing from the test fixture");
  return row;
}
