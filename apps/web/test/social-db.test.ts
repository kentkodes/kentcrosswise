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

    expect(yt.latest).toEqual({ day: DAYS.d2, followers: 1250, views: 9000, followersExact: true });
    expect(yt.change).toEqual({ followers: 150, views: null }); // d1 had no views, so no views change
    expect(ig.latest).toEqual({ day: DAYS.d3, followers: 300, views: null, followersExact: false });
    expect(ig.change).toEqual({ followers: null, views: null });
    expect(tt.latest).toEqual({ day: DAYS.d4, followers: 45, views: 700, followersExact: true });
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
    expect(idOf(rows, "test_api_feed")).toMatchObject({ ingest: "api", latest: null, trend: [], snapshots: 0 });
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
    expect(idOf(asStrings, "test_string_driver").latest).toEqual({ day: DAYS.d2, followers: 80, views: 12400, followersExact: true });
    expect(idOf(asStrings, "test_string_driver").change).toEqual({ followers: 3, views: 55 });
  });
});

function idOf(rows: AccountRow[], handle: string): AccountRow {
  const row = rows.find((r) => r.handle === handle);
  if (!row) throw new Error("account missing from the test fixture");
  return row;
}
