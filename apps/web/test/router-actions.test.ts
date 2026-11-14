// /hub and /inbox routing actions. The owner check runs first; bad ids and kinds never reach the DB; each
// action ends in a redirect with a fixed notice code. The DB is real (PGlite) through a mocked withDb, and the
// provider is a FakeProvider (routerFromEnv is replaced, so the models secret is never read).
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runAs } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

const f = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  withDb: vi.fn(),
  redirect: vi.fn(),
  routerFromEnv: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: f.redirect }));
vi.mock("@/server/owner", () => ({ requireOwner: f.requireOwner }));
// The '@/' alias does not resolve under this vitest setup, so each mock loads the real module by relative path
// and overrides only what these actions need (the same pattern as hub-capture-action.test.ts).
vi.mock("@/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("../src/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("@/server/capture", async () => await import("../src/server/capture"));
vi.mock("@/server/console", async () => await import("../src/server/console"));
vi.mock("@/server/orchestrator-queue", async () => await import("../src/server/orchestrator-queue"));
vi.mock("@/server/router", async () => ({ ...(await import("../src/server/router")), routerFromEnv: f.routerFromEnv }));
vi.mock("../src/server/router", async () => ({ ...(await import("../src/server/router")), routerFromEnv: f.routerFromEnv }));

import { captureAction, reassignAction, routeAgainAction } from "../src/app/(owner)/hub/actions";
import { reassignRoutingAction } from "../src/app/(owner)/inbox/actions";

const ENTRY_ID = "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

describe("owner gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("every routing action stops before reading or writing anything for a non-owner", async () => {
    f.requireOwner.mockRejectedValue(new Error("NEXT_REDIRECT /api/auth/signin"));
    await expect(reassignAction(form({ entry_id: ENTRY_ID, to: "todo" }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(routeAgainAction(form({ entry_id: ENTRY_ID }))).rejects.toThrow("NEXT_REDIRECT");
    await expect(reassignRoutingAction(form({ entry_id: ENTRY_ID, to: "todo" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(f.requireOwner).toHaveBeenCalledTimes(3);
    expect(f.withDb).not.toHaveBeenCalled();
    expect(f.routerFromEnv).not.toHaveBeenCalled();
    expect(f.redirect).not.toHaveBeenCalled();
  });
});

describe("reassign and route again: bad input never reaches the DB", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    f.requireOwner.mockResolvedValue(undefined);
  });

  it("rejects a malformed entry id and an unknown kind", async () => {
    await reassignAction(form({ entry_id: "not-a-uuid", to: "todo" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=invalid");
    await reassignAction(form({ entry_id: ENTRY_ID, to: "project" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=invalid");
    await reassignRoutingAction(form({ entry_id: ENTRY_ID }));
    expect(f.redirect).toHaveBeenLastCalledWith("/inbox?n=invalid");
    await routeAgainAction(form({}));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=invalid");
    expect(f.withDb).not.toHaveBeenCalled();
  });

  it("reassigns through web_rw and redirects with the routed notice, or not-found for an unknown entry", async () => {
    f.withDb.mockResolvedValueOnce("ok");
    await reassignAction(form({ entry_id: ENTRY_ID, to: "todo" }));
    expect(f.withDb).toHaveBeenCalledExactlyOnceWith("web_rw", expect.any(Function));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=routed-todo");

    f.withDb.mockResolvedValueOnce("not-found");
    await reassignRoutingAction(form({ entry_id: ENTRY_ID, to: "idea" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/inbox?n=entry-not-found");
  });

  it("route again with routing off says so and does no DB work", async () => {
    f.routerFromEnv.mockResolvedValueOnce(undefined);
    await routeAgainAction(form({ entry_id: ENTRY_ID }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=route-off");
    expect(f.withDb).not.toHaveBeenCalled();
  });
});

describe("capture with routing (real PGlite, FakeProvider)", () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await freshDb();
    // Every DB call the actions make goes to the same PGlite session, as web_rw.
    f.withDb.mockImplementation((role: "web_rw" | "web_public", fn: never) => runAs(pglitePool(pg), role, fn));
  });
  afterAll(async () => {
    await pg.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    f.requireOwner.mockResolvedValue(undefined);
    f.withDb.mockImplementation((role: "web_rw" | "web_public", fn: never) => runAs(pglitePool(pg), role, fn));
  });

  async function latestEntry(): Promise<{ id: string; route_kind: string | null; status: string | null }> {
    const { rows } = await pg.query<{ id: string; route_kind: string | null; status: string | null }>(
      "SELECT id, route_kind, status FROM entries ORDER BY created_at DESC, id DESC LIMIT 1",
    );
    return rows[0]!;
  }

  it("a confident route saves and says so; the entry is routed", async () => {
    f.routerFromEnv.mockResolvedValueOnce(new FakeProvider({ classify: { label: "diary", confidence: 0.95 } }));
    await captureAction(form({ raw_text: "The day went well" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-routed-diary");
    expect(await latestEntry()).toMatchObject({ route_kind: "diary", status: "routed" });
  });

  it("a low-confidence route saves, says it needs the owner, and opens an inbox item", async () => {
    f.routerFromEnv.mockResolvedValueOnce(new FakeProvider({ classify: { label: "todo", confidence: 0.3 } }));
    await captureAction(form({ raw_text: "Maybe buy stamps" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-needs-owner");
    expect(await latestEntry()).toMatchObject({ route_kind: "todo", status: "needs_owner" });
    const { rows } = await pg.query("SELECT 1 FROM inbox_items WHERE kind = 'routing' AND status = 'open'");
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("a provider error keeps the saved entry pending and says routing failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.routerFromEnv.mockResolvedValueOnce(new FakeProvider({ classify: new Error("down") }));
    await captureAction(form({ raw_text: "Saved even though routing fails" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-route-failed");
    expect(await latestEntry()).toMatchObject({ route_kind: null, status: null });
    log.mockRestore();
  });

  it("a config read that throws is a failed route, not a failed capture", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.routerFromEnv.mockRejectedValueOnce(Object.assign(new Error("secret unreadable"), { name: "SecretNotFoundError" }));
    await captureAction(form({ raw_text: "Config is broken" }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-route-failed");
    expect(await latestEntry()).toMatchObject({ route_kind: null });
    expect(log).toHaveBeenCalledWith("[router] SecretNotFoundError");
    log.mockRestore();
  });

  it("route again on a pending entry routes it and redirects with the kind", async () => {
    // Make a pending entry with routing off, then route it.
    f.routerFromEnv.mockResolvedValueOnce(undefined);
    await captureAction(form({ raw_text: "Route me later" }));
    const pending = await latestEntry();
    expect(pending.route_kind).toBeNull();
    f.routerFromEnv.mockResolvedValueOnce(new FakeProvider({ classify: { label: "idea", confidence: 0.8 } }));
    await routeAgainAction(form({ entry_id: pending.id }));
    expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=routed-idea");
    expect(await latestEntry()).toMatchObject({ id: pending.id, route_kind: "idea", status: "routed" });
  });

  it("a capture over the monthly cap is saved and says routing is paused", async () => {
    await pg.query(
      "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES ('model', 'orchestrator', 'deepseek', 'deepseek-flash', 1, 1, 50)",
    );
    try {
      const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.9 } });
      f.routerFromEnv.mockResolvedValueOnce(provider);
      await captureAction(form({ raw_text: "Over the cap today" }));
      expect(f.redirect).toHaveBeenLastCalledWith("/hub?n=captured-route-capped");
      expect(provider.calls).toHaveLength(0);
    } finally {
      await pg.query("DELETE FROM usage_events WHERE agent = 'orchestrator'");
    }
  });
});
