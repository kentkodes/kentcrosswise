import type * as OfficeProjection from "../src/server/office-projection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeOfficeCursor, loadOfficeProjection } from "../src/server/office-projection";
import { GET, dynamic } from "../src/app/api/public/office/route";
import { bootstrapFixture, REFS, unavailableFixture } from "./fixtures/office-contract";

vi.mock("../src/server/office-projection", async (importOriginal) => {
  const actual = await importOriginal<typeof OfficeProjection>();
  return { ...actual, loadOfficeProjection: vi.fn() };
});
const load = vi.mocked(loadOfficeProjection);
const cursor = encodeOfficeCursor({ generation: REFS.generation, privacy_epoch: "2", position: { revision: "10", ordinal: 1 }, watermark: { revision: "10", ordinal: 2 } });
const SNAPSHOT_CACHE = "public, max-age=2, s-maxage=2";
const call = (query = "") => GET(new Request(`http://localhost/api/public/office${query ? `?${query}` : ""}`));

beforeEach(() => { load.mockReset(); load.mockResolvedValue(bootstrapFixture()); });

describe("connected office GET", () => {
  it("uses a dynamic read with a 2 s shared cache for bootstrap, including an omitted mode", async () => {
    expect(dynamic).toBe("force-dynamic");
    for (const query of ["", "mode=bootstrap"]) {
      const response = await call(query);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe(SNAPSHOT_CACHE);
      expect(await response.json()).toEqual(bootstrapFixture());
      expect(load).toHaveBeenLastCalledWith({ mode: "bootstrap" });
    }
  });
  it("passes only allowlisted state fields including zero and bigint max epochs", async () => {
    for (const epoch of [undefined, "0", "2", "9223372036854775807"]) {
      const response = await call(`mode=state${epoch === undefined ? "" : `&privacy_epoch=${epoch}`}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe(SNAPSHOT_CACHE);
      expect(load).toHaveBeenLastCalledWith(epoch === undefined ? { mode: "state" } : { mode: "state", privacy_epoch: epoch });
    }
  });
  it("validates canonical cursors and optional page/rebind fields before loading", async () => {
    const first = await call(`mode=incremental&cursor=${cursor}&limit=50&rebind=true`);
    expect(first.status).toBe(200);
    // Cursor pages are never shared.
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(load).toHaveBeenLastCalledWith({ mode: "incremental", cursor, limit: 50, rebind: true });
    expect((await call(`mode=incremental&cursor=${cursor}&limit=1&rebind=false`)).status).toBe(200);
    expect(load).toHaveBeenLastCalledWith({ mode: "incremental", cursor, limit: 1, rebind: false });
    await call(`mode=incremental&cursor=${cursor}`);
    expect(load).toHaveBeenLastCalledWith({ mode: "incremental", cursor });
  });
  it("rejects malformed, duplicate and incompatible query fields without loading", async () => {
    const bad = [
      "mode=unknown", "mode=", "mode=bootstrap&cursor=secret", "mode=bootstrap&rebind=false", "x=secret", "mode=state&x=secret",
      "mode=state&mode=state", "mode=state&privacy_epoch=1&privacy_epoch=2", "mode=state&cursor=secret", "mode=state&limit=1",
      ...["", "-1", "01", "1.5", "1e3", "+1", "9223372036854775808", "99999999999999999999999"].map((v) => `mode=state&privacy_epoch=${v}`),
      "mode=incremental", "mode=incremental&cursor=secret", "mode=incremental&cursor=cur_SyntheticBindingForTestsOnly_v1",
      `mode=incremental&cursor=${cursor}&cursor=${cursor}`, `mode=incremental&cursor=${cursor}&privacy_epoch=2`,
      ...["", "0", "51", "01", "1.5", "1e1", "-1", "+1", "100000000000000000000"].map((v) => `mode=incremental&cursor=${cursor}&limit=${v}`),
      ...["", "1", "yes", "TRUE"].map((v) => `mode=incremental&cursor=${cursor}&rebind=${v}`),
      `mode=incremental&cursor=${cursor}&rebind=true&rebind=true`,
    ];
    for (const query of bad) {
      const response = await call(query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "Invalid office request" });
    }
    expect(load).not.toHaveBeenCalled();
  });
  it("returns a content-free unavailable envelope without caching", async () => {
    load.mockResolvedValue(unavailableFixture());
    for (const query of ["", "mode=state", `mode=incremental&cursor=${cursor}`]) {
      const response = await call(query);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control"), query).toBe("no-store");
      expect(await response.json()).toEqual(unavailableFixture());
    }
  });
  it("does not expose unexpected exception text and disables caching on errors", async () => {
    load.mockRejectedValue(new Error("private internal text"));
    for (const query of ["", "mode=state"]) {
      const response = await call(query);
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: "Office unavailable" });
    }
  });
});
