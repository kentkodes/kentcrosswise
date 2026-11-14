// H3 routing: thresholds, skips, the owner-choice guard, the spend cap, provider errors, usage rows,
// reassignment and the routing inbox. PGlite and FakeProvider only; no model is ever called for real.
import type { PGlite } from "@electric-sql/pglite";
import { createFakeSecrets, setDefaultSecretStore } from "@kcw/secrets";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeProvider } from "@kcw/core/models";
import { saveEntry, type RouteKind } from "../src/server/capture";
import { runAs, type Queryable } from "../src/server/db";
import {
  isEntryId,
  isRouteKind,
  listRoutingInbox,
  MODELS_SECRET_ENV,
  reassignEntry,
  recordRouterUsage,
  ROUTE_THRESHOLD,
  routeEntry,
  routerFromEnv,
  routingEnabled,
  routingTitle,
  type DbRun,
} from "../src/server/router";
import { freshDb, pglitePool } from "./pglite";

const ENTRY = "Call Sam about the trip";

describe("routingTitle", () => {
  it("is one line with the first 60 characters, and an ellipsis only when cut", () => {
    expect(routingTitle("Call Sam\n\n  about   the plan ")).toBe("Routing: Call Sam about the plan");
    const exact = "x".repeat(60);
    expect(routingTitle(exact)).toBe(`Routing: ${exact}`);
    expect(routingTitle("y".repeat(61))).toBe(`Routing: ${"y".repeat(60)}…`);
  });
});

describe("guards", () => {
  it("accepts the five kinds and a lowercase uuid, and nothing else", () => {
    for (const k of ["crm_note", "diary", "todo", "idea", "agent_request"]) expect(isRouteKind(k)).toBe(true);
    expect(isRouteKind("project")).toBe(false);
    expect(isRouteKind("__proto__")).toBe(false);
    expect(isEntryId("8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b")).toBe(true);
    expect(isEntryId("not-a-uuid")).toBe(false);
    expect(isEntryId(null)).toBe(false);
  });
});

describe("routerFromEnv", () => {
  afterEach(() => setDefaultSecretStore(undefined));

  it("is off without the models secret name: no provider, routing disabled", async () => {
    expect(routingEnabled({})).toBe(false);
    await expect(routerFromEnv({})).resolves.toBeUndefined();
    await expect(routerFromEnv({ [MODELS_SECRET_ENV]: "" })).resolves.toBeUndefined();
  });

  it("builds the DeepSeek provider from the secret, with defaults, and reads the API key only when used", async () => {
    // A fake store: no AWS, and no call to any model (the provider is never asked to classify here).
    const { store } = createFakeSecrets({ "kcw/prod/router": { deepseek_api_key: "fake-key" } });
    const get = vi.spyOn(store, "get");
    setDefaultSecretStore(store);
    expect(routingEnabled({ [MODELS_SECRET_ENV]: "kcw/prod/router" })).toBe(true);
    const provider = await routerFromEnv({ [MODELS_SECRET_ENV]: "kcw/prod/router" });
    expect(provider?.name).toBe("deepseek");
    const keyReads = get.mock.calls.filter(([, key]) => key === "deepseek_api_key");
    expect(keyReads).toHaveLength(0);
  });
});

describe("routeEntry (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => pg.query<R>(sql, params);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  async function newEntry(text = ENTRY): Promise<string> {
    return await run((db) => saveEntry(db, text));
  }

  it("confidence 0.59 is needs_owner: the guess is kept and one open routing item is added", async () => {
    const id = await newEntry();
    const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.59 } });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "needs_owner", kind: "todo" });
    const { rows } = await q<{ route_kind: string; status: string; routed_by: string; route_model: string }>(
      "SELECT route_kind, status, routed_by, route_model FROM entries WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([{ route_kind: "todo", status: "needs_owner", routed_by: "model", route_model: "fake-model-1" }]);
    const items = await q<{ kind: string; ref_table: string; ref_id: string; title: string; status: string }>(
      "SELECT kind, ref_table, ref_id, title, status FROM inbox_items WHERE ref_id = $1",
      [id],
    );
    expect(items.rows).toEqual([{ kind: "routing", ref_table: "entries", ref_id: id, title: `Routing: ${ENTRY}`, status: "open" }]);
  });

  it("confidence 0.6 is routed: the route is stored and no inbox item is added", async () => {
    const id = await newEntry("Ideas for a new essay series");
    const provider = new FakeProvider({ classify: { label: "idea", confidence: ROUTE_THRESHOLD } });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "routed", kind: "idea" });
    const { rows } = await q<{ status: string; route_confidence: number }>(
      "SELECT status, route_confidence FROM entries WHERE id = $1",
      [id],
    );
    expect(rows[0]!.status).toBe("routed");
    expect(rows[0]!.route_confidence).toBeCloseTo(0.6, 5);
    const items = await q("SELECT 1 FROM inbox_items WHERE ref_id = $1", [id]);
    expect(items.rows).toHaveLength(0);
  });

  it("skips an entry that is already routed: no model call, no change", async () => {
    const id = await newEntry("Already routed by hand");
    await run((db) => reassignEntry(db, id, "diary"));
    const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.9 } });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "already" });
    expect(provider.calls).toHaveLength(0);
    const { rows } = await q<{ route_kind: string }>("SELECT route_kind FROM entries WHERE id = $1", [id]);
    expect(rows[0]!.route_kind).toBe("diary");
  });

  it("keeps an owner's choice made while the model call is running", async () => {
    const id = await newEntry("Owner picks while the model thinks");
    const provider = new FakeProvider({
      classify: async () => {
        // The owner reassigns the entry during the call (its own transaction, outside the router's).
        await q("UPDATE entries SET route_kind = 'diary', routed_by = 'owner', status = 'routed' WHERE id = $1", [id]);
        return { label: "todo", confidence: 0.2 };
      },
    });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "already" });
    const { rows } = await q<{ route_kind: string; routed_by: string; status: string }>(
      "SELECT route_kind, routed_by, status FROM entries WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([{ route_kind: "diary", routed_by: "owner", status: "routed" }]);
    const items = await q("SELECT 1 FROM inbox_items WHERE ref_id = $1", [id]);
    expect(items.rows).toHaveLength(0);
  });

  it("does not call the model once the monthly spend cap is reached, and the entry stays pending", async () => {
    await q(
      "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES ('model', 'orchestrator', 'deepseek', 'deepseek-flash', 1, 1, 50)",
    );
    try {
      const id = await newEntry("Over the cap");
      const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.9 } });
      await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "cap" });
      expect(provider.calls).toHaveLength(0);
      const { rows } = await q<{ route_kind: string | null }>("SELECT route_kind FROM entries WHERE id = $1", [id]);
      expect(rows[0]!.route_kind).toBeNull();
    } finally {
      // The other tests in this file run under the same month: lift the cap again.
      await q("DELETE FROM usage_events WHERE agent = 'orchestrator'");
    }
  });

  it("a provider error leaves the entry pending, logs only the error class, and never logs the text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await newEntry("private text that must not be logged");
    const provider = new FakeProvider({ classify: new Error("provider says private text back") });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "error" });
    expect(log).toHaveBeenCalledExactlyOnceWith("[router] Error");
    const { rows } = await q<{ route_kind: string | null }>("SELECT route_kind FROM entries WHERE id = $1", [id]);
    expect(rows[0]!.route_kind).toBeNull();
    log.mockRestore();
  });

  it("a label outside the five kinds is an error, and the entry stays pending", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await newEntry("Model invents a label");
    const provider = new FakeProvider({ classify: { label: "project", confidence: 0.9 } });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "error" });
    const { rows } = await q<{ route_kind: string | null }>("SELECT route_kind FROM entries WHERE id = $1", [id]);
    expect(rows[0]!.route_kind).toBeNull();
    log.mockRestore();
  });

  it("a failed usage write fails the route: the entry stays pending and only the error class is logged", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const id = await newEntry("Usage write fails");
    const provider = new FakeProvider({
      classify: { label: "todo", confidence: 0.9 },
      onUsage: async () => {
        throw new TypeError("usage insert failed");
      },
    });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "error" });
    expect(log).toHaveBeenCalledExactlyOnceWith("[router] TypeError");
    const { rows } = await q<{ route_kind: string | null }>("SELECT route_kind FROM entries WHERE id = $1", [id]);
    expect(rows[0]!.route_kind).toBeNull();
    log.mockRestore();
  });

  it("writes one usage_events row per model call (kind model, agent router) through onUsage", async () => {
    const id = await newEntry("Usage row check");
    const provider = new FakeProvider({
      name: "deepseek",
      model: "deepseek-flash",
      classify: { label: "todo", confidence: 0.9, model: "deepseek-flash-2026" },
      onUsage: (u) => run((db) => recordRouterUsage(db, u)),
    });
    await expect(routeEntry(run, id, provider)).resolves.toEqual({ code: "routed", kind: "todo" });
    const { rows } = await q<{ kind: string; agent: string; provider: string; model: string }>(
      "SELECT kind, agent, provider, model FROM usage_events WHERE agent = 'router'",
    );
    expect(rows).toEqual([{ kind: "model", agent: "router", provider: "deepseek", model: "deepseek-flash-2026" }]);
  });

  it("an entry that does not exist is an error and nothing is written", async () => {
    const provider = new FakeProvider({ classify: { label: "todo", confidence: 0.9 } });
    await expect(routeEntry(run, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b", provider)).resolves.toEqual({ code: "error" });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("reassignEntry and the routing inbox (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => pg.query<R>(sql, params);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  async function routedEntry(kind: RouteKind | null, confidence: number, text = ENTRY): Promise<string> {
    const id = await run((db) => saveEntry(db, text));
    if (kind !== null) {
      await routeEntry(run, id, new FakeProvider({ classify: { label: kind, confidence } }));
    }
    return id;
  }

  it("a pending entry gets its first route with no correction, and its routing item is closed", async () => {
    const id = await routedEntry(null, 0);
    await expect(run((db) => reassignEntry(db, id, "todo"))).resolves.toBe("ok");
    const { rows } = await q<{ route_kind: string; routed_by: string; status: string }>(
      "SELECT route_kind, routed_by, status FROM entries WHERE id = $1",
      [id],
    );
    expect(rows).toEqual([{ route_kind: "todo", routed_by: "owner", status: "routed" }]);
    expect((await q("SELECT 1 FROM route_corrections WHERE entry_id = $1", [id])).rows).toHaveLength(0);
  });

  it("the same kind as the model's guess is not a correction, but it closes the item and marks the owner route", async () => {
    const id = await routedEntry("idea", 0.3);
    await expect(run((db) => reassignEntry(db, id, "idea"))).resolves.toBe("ok");
    expect((await q("SELECT 1 FROM route_corrections WHERE entry_id = $1", [id])).rows).toHaveLength(0);
    const item = await q<{ status: string; resolved_at: Date | null }>(
      "SELECT status, resolved_at FROM inbox_items WHERE ref_id = $1",
      [id],
    );
    expect(item.rows).toHaveLength(1);
    expect(item.rows[0]!.status).toBe("done");
    expect(item.rows[0]!.resolved_at).not.toBeNull();
    const { rows } = await q<{ routed_by: string; status: string }>("SELECT routed_by, status FROM entries WHERE id = $1", [id]);
    expect(rows).toEqual([{ routed_by: "owner", status: "routed" }]);
  });

  it("a different kind stores a correction from the model's guess to the owner's choice", async () => {
    const id = await routedEntry("idea", 0.3);
    await expect(run((db) => reassignEntry(db, id, "todo"))).resolves.toBe("ok");
    const corrections = await q<{ from_kind: string; to_kind: string }>(
      "SELECT from_kind, to_kind FROM route_corrections WHERE entry_id = $1",
      [id],
    );
    expect(corrections.rows).toEqual([{ from_kind: "idea", to_kind: "todo" }]);
  });

  it("an unknown entry is not-found and nothing is written", async () => {
    await expect(run((db) => reassignEntry(db, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b", "todo"))).resolves.toBe("not-found");
  });

  it("lists only open routing items, oldest first, with the guess and confidence", async () => {
    const older = await routedEntry("diary", 0.41, "Older entry, still open");
    const newer = await routedEntry("crm_note", 0.07, "Newer entry, still open");
    const closed = await routedEntry("todo", 0.2, "Closed entry");
    // Explicit times, so the order does not depend on the clock resolution of the test run.
    await q("UPDATE inbox_items SET created_at = '2021-01-02T00:00:00Z' WHERE ref_id = $1", [newer]);
    await q("UPDATE inbox_items SET created_at = '2021-01-01T00:00:00Z' WHERE ref_id = $1", [older]);
    await run((db) => reassignEntry(db, closed, "todo"));

    const items = await run((db: Queryable) => listRoutingInbox(db));
    expect(items.map((i) => i.entryId)).toEqual([older, newer]);
    expect(items[0]).toMatchObject({ rawText: "Older entry, still open", guess: "diary", confidence: expect.closeTo(0.41, 2) });
    expect(items[1]).toMatchObject({ guess: "crm_note", confidence: expect.closeTo(0.07, 2) });
    expect(items[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

