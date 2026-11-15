import { describe, expect, it } from "vitest";
import {
  checkSnapshot,
  inSource,
  MAX_HANDLE_CHARS,
  newAccountFromForm,
  normalizeHandle,
  parseCount,
  parseDay,
  parsePlatform,
  parseSource,
  snapshotFromForm,
  SocialInputError,
  toCount,
  totalsFor,
  todayUtc,
  type AccountRow,
  type SnapshotInput,
} from "../src/server/social";

const ACCOUNT = "3f9a2c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const TODAY = "2026-11-14";

/** Runs fn and returns the SocialInputError code it throws (fails the test if nothing is thrown). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SocialInputError) return err.code;
    throw err;
  }
  throw new Error("expected a SocialInputError");
}

function form(fields: Record<string, string>, checked: string[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const k of checked) f.set(k, "on");
  return f;
}

describe("parseSource", () => {
  it("accepts the four sources and falls back to all", () => {
    expect(parseSource("youtube")).toBe("youtube");
    expect(parseSource("instagram")).toBe("instagram");
    expect(parseSource("tiktok")).toBe("tiktok");
    expect(parseSource("all")).toBe("all");
    expect(parseSource("facebook")).toBe("all");
    expect(parseSource(undefined)).toBe("all");
    expect(parseSource(["youtube", "tiktok"])).toBe("all");
  });
});

describe("parsePlatform", () => {
  it("accepts the three platforms only", () => {
    expect(parsePlatform("youtube")).toBe("youtube");
    expect(codeOf(() => parsePlatform("all"))).toBe("platform");
    expect(codeOf(() => parsePlatform("YouTube"))).toBe("platform");
    expect(codeOf(() => parsePlatform(null))).toBe("platform");
  });
});

describe("normalizeHandle", () => {
  it("trims and drops leading @ signs, so the stored handle has neither", () => {
    expect(normalizeHandle("  @example_creator ")).toBe("example_creator");
    expect(normalizeHandle("@@sample.handle")).toBe("sample.handle");
    expect(normalizeHandle("@ sample-two")).toBe("sample-two");
    expect(normalizeHandle("plain")).toBe("plain");
  });

  it("keeps the case as typed", () => {
    expect(normalizeHandle("@MixedCase")).toBe("MixedCase");
  });

  it("rejects empty, too long, and handles with spaces or symbols", () => {
    expect(codeOf(() => normalizeHandle(""))).toBe("handle");
    expect(codeOf(() => normalizeHandle("   "))).toBe("handle");
    expect(codeOf(() => normalizeHandle("@"))).toBe("handle");
    expect(codeOf(() => normalizeHandle("a".repeat(MAX_HANDLE_CHARS + 1)))).toBe("handle");
    expect(normalizeHandle("a".repeat(MAX_HANDLE_CHARS))).toHaveLength(MAX_HANDLE_CHARS);
    expect(codeOf(() => normalizeHandle("two words"))).toBe("handle");
    expect(codeOf(() => normalizeHandle("https://example.invalid/x"))).toBe("handle");
    expect(codeOf(() => normalizeHandle(42))).toBe("handle");
  });
});

describe("parseCount", () => {
  it("treats an empty box as no number", () => {
    expect(parseCount("", "followers")).toBeNull();
    expect(parseCount("   ", "views")).toBeNull();
    expect(parseCount(null, "views")).toBeNull();
    expect(parseCount(undefined, "followers")).toBeNull();
  });

  it("accepts whole non-negative numbers, with surrounding spaces", () => {
    expect(parseCount("0", "followers")).toBe(0);
    expect(parseCount(" 1234 ", "followers")).toBe(1234);
    expect(parseCount("007", "views")).toBe(7);
    expect(parseCount(String(Number.MAX_SAFE_INTEGER), "views")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects signs, decimals, separators, exponents and words, naming the field", () => {
    for (const bad of ["-1", "1.5", "1,000", "1e3", "12a", "+3", "١٢"]) {
      expect(codeOf(() => parseCount(bad, "followers"))).toBe("followers");
      expect(codeOf(() => parseCount(bad, "views"))).toBe("views");
    }
  });

  it("rejects numbers past the safe integer range", () => {
    expect(codeOf(() => parseCount("9007199254740993", "views"))).toBe("views");
  });
});

describe("parseDay", () => {
  it("accepts today and past days in YYYY-MM-DD", () => {
    expect(parseDay("2026-11-14", TODAY)).toBe("2026-11-14");
    expect(parseDay("2024-02-29", TODAY)).toBe("2024-02-29");
  });

  it("rejects future days, impossible dates and other shapes", () => {
    expect(codeOf(() => parseDay("2026-11-15", TODAY))).toBe("day");
    expect(codeOf(() => parseDay("2026-02-30", TODAY))).toBe("day");
    expect(codeOf(() => parseDay("2026-13-01", TODAY))).toBe("day");
    expect(codeOf(() => parseDay("14/11/2026", TODAY))).toBe("day");
    expect(codeOf(() => parseDay("", TODAY))).toBe("day");
    expect(codeOf(() => parseDay(null, TODAY))).toBe("day");
  });

  it("defaults to today in UTC", () => {
    expect(todayUtc(new Date("2026-11-14T23:30:00Z"))).toBe("2026-11-14");
    expect(parseDay(todayUtc())).toBe(todayUtc());
  });
});

describe("checkSnapshot", () => {
  const base: SnapshotInput = { accountId: ACCOUNT, day: "2026-11-13", followers: 100, views: 900, followersExact: true };

  it("accepts a complete snapshot and returns it unchanged", () => {
    expect(checkSnapshot(base, TODAY)).toEqual(base);
  });

  it("accepts followers only and views only (the other is null)", () => {
    expect(checkSnapshot({ ...base, views: null }, TODAY)).toMatchObject({ followers: 100, views: null });
    expect(checkSnapshot({ ...base, followers: null }, TODAY)).toMatchObject({ followers: null, views: 900 });
  });

  it("rejects an entry with neither followers nor views", () => {
    expect(codeOf(() => checkSnapshot({ ...base, followers: null, views: null }, TODAY))).toBe("empty");
  });

  it("rejects an unknown account id and a future day", () => {
    expect(codeOf(() => checkSnapshot({ ...base, accountId: "not-a-uuid" }, TODAY))).toBe("account");
    expect(codeOf(() => checkSnapshot({ ...base, day: "2026-11-15" }, TODAY))).toBe("day");
  });

  it("rejects negative, fractional and unsafe numbers", () => {
    expect(codeOf(() => checkSnapshot({ ...base, followers: -1 }, TODAY))).toBe("followers");
    expect(codeOf(() => checkSnapshot({ ...base, views: 1.5 }, TODAY))).toBe("views");
    expect(codeOf(() => checkSnapshot({ ...base, views: Number.MAX_SAFE_INTEGER + 2 }, TODAY))).toBe("views");
  });
});

describe("snapshotFromForm and newAccountFromForm", () => {
  const today = TODAY;

  it("reads a manual snapshot form, with an empty box as null and the rounded box as not exact", () => {
    const f = form({ account_id: ACCOUNT, day: "2026-11-13", followers: "1200", views: "" }, ["followers_rounded"]);
    expect(snapshotFromForm(f, today)).toEqual({
      accountId: ACCOUNT,
      day: "2026-11-13",
      followers: 1200,
      views: null,
      followersExact: false,
    });
  });

  it("treats an unticked box as exact followers", () => {
    const f = form({ account_id: ACCOUNT, day: "2026-11-13", followers: "5", views: "6" });
    expect(snapshotFromForm(f, today).followersExact).toBe(true);
  });

  it("names the field that is wrong", () => {
    expect(codeOf(() => snapshotFromForm(form({ account_id: ACCOUNT, day: "2026-11-13", followers: "x" }), today))).toBe("followers");
    expect(codeOf(() => snapshotFromForm(form({ account_id: ACCOUNT, day: "2026-11-13", views: "-4" }), today))).toBe("views");
    expect(codeOf(() => snapshotFromForm(form({ account_id: ACCOUNT, day: "", followers: "1" }), today))).toBe("day");
    expect(codeOf(() => snapshotFromForm(form({ account_id: "", day: "2026-11-13", followers: "1" }), today))).toBe("account");
    expect(codeOf(() => snapshotFromForm(form({ account_id: ACCOUNT, day: "2026-11-13" }), today))).toBe("empty");
  });

  it("reads the add account form, with the handle normalised", () => {
    expect(newAccountFromForm(form({ platform: "tiktok", handle: " @sample.creator " }))).toEqual({
      platform: "tiktok",
      handle: "sample.creator",
    });
    expect(codeOf(() => newAccountFromForm(form({ platform: "myspace", handle: "x" })))).toBe("platform");
    expect(codeOf(() => newAccountFromForm(form({ platform: "tiktok", handle: "" })))).toBe("handle");
  });
});

describe("toCount", () => {
  it("reads node-postgres strings and PGlite numbers the same way", () => {
    expect(toCount("250")).toBe(250);
    expect(toCount(250)).toBe(250);
    expect(toCount(0)).toBe(0);
    expect(toCount("0")).toBe(0);
    expect(toCount(null)).toBeNull();
    expect(toCount(undefined)).toBeNull();
  });

  it("keeps values up to the safe integer limit", () => {
    expect(toCount(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("throws for anything that is not a count, without putting the value in the message", () => {
    expect(() => toCount("12.5")).toThrow(/unexpected type/);
    expect(() => toCount("-3")).toThrow(/unexpected type/);
    expect(() => toCount({})).toThrow(/unexpected type/);
    expect(() => toCount("9007199254740993")).toThrow(/safe integer/);
    expect(() => toCount(1.5)).toThrow(/safe integer/);
  });
});

function row(p: Partial<AccountRow> & Pick<AccountRow, "platform">): AccountRow {
  return {
    id: `id-${p.platform}-${p.handle ?? "x"}`,
    handle: "x",
    ingest: "manual",
    snapshots: 0,
    latest: null,
    change: { followers: null, views: null },
    trend: [],
    ...p,
  };
}

describe("inSource and totalsFor", () => {
  const rows: AccountRow[] = [
    row({
      platform: "youtube",
      latest: { day: "2026-11-13", followers: 100, views: 1000, followersExact: true },
    }),
    row({
      platform: "instagram",
      latest: { day: "2026-11-13", followers: 40, views: null, followersExact: false },
    }),
    row({ platform: "tiktok", latest: null }),
  ];

  it("keeps the rows of one source, or all of them", () => {
    expect(inSource(rows, "all")).toHaveLength(3);
    expect(inSource(rows, "instagram").map((r) => r.platform)).toEqual(["instagram"]);
    expect(inSource(rows, "tiktok")).toHaveLength(1);
  });

  it("sums the latest numbers, and shows null when no account has that number", () => {
    expect(totalsFor(rows)).toEqual({ accounts: 3, followers: 140, views: 1000 });
    expect(totalsFor(inSource(rows, "instagram"))).toEqual({ accounts: 1, followers: 40, views: null });
    expect(totalsFor(inSource(rows, "tiktok"))).toEqual({ accounts: 1, followers: null, views: null });
    expect(totalsFor([])).toEqual({ accounts: 0, followers: null, views: null });
  });
});
