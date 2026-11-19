// GET /api/public/log: returns the loader's result as JSON with a 30 s shared cache (PL4).
import { describe, expect, it, vi } from "vitest";

const log = { available: true, label: "L", counts: { published: 1, withheld: 0, awaitingReview: 2 }, records: [] };
vi.mock("@/server/public-log", () => ({ loadPublicLog: async () => log }));

const { GET } = await import("../src/app/api/public/log/route");

describe("GET /api/public/log", () => {
  it("returns the public log with a 30 s shared cache", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toBe("public, max-age=30, s-maxage=30");
    expect(await res.json()).toEqual(log);
  });
});
