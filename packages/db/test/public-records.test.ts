import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0027: published records of the public log (slice PL4, DESIGN §4.6). Owner-critical: web_public reads two views.
// Synthetic text only.
describe("0027 public_records", () => {
  let pg: PGlite;
  let db: SqlClient;
  const entry = async (text = "synthetic") =>
    (await db.query<{ id: string }>("INSERT INTO entries (source, raw_text, route_kind, status, routed_by) VALUES ('web', $1, 'idea', 'routed', 'model') RETURNING id", [text])).rows[0]!.id;
  const as = async <T>(role: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`BEGIN; SET LOCAL ROLE ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec("ROLLBACK");
    }
  };
  const publish = (id: string, body = "public text", steps = "[]") =>
    db.query("INSERT INTO public_records (entry_id, state, kind, captured_hour, body, steps) VALUES ($1, 'published', 'idea', date_trunc('hour', now()), $2, $3::jsonb)", [id, body, steps]);
  const withhold = (id: string) =>
    db.query("INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour) VALUES ($1, 'withheld', 'private-other', 'idea', date_trunc('hour', now()))", [id]);

  beforeAll(async () => {
    ({ pg, db } = await freshDb());
  });
  afterAll(async () => {
    await pg.close();
  });

  it("is migration 0027", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0027")?.name).toBe("public_records");
  });

  it.each([
    ["published without text", "INSERT INTO public_records (entry_id, state, kind, captured_hour) VALUES ($1, 'published', 'idea', date_trunc('hour', now()))"],
    ["withheld with text", "INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour, body) VALUES ($1, 'withheld', 'x', 'idea', date_trunc('hour', now()), 't')"],
    ["withheld without a reason", "INSERT INTO public_records (entry_id, state, kind, captured_hour) VALUES ($1, 'withheld', 'idea', date_trunc('hour', now()))"],
    ["withheld with steps", "INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour, steps) VALUES ($1, 'withheld', 'x', 'idea', date_trunc('hour', now()), '[{}]')"],
    ["a time that is not on the hour", "INSERT INTO public_records (entry_id, state, kind, captured_hour, body) VALUES ($1, 'published', 'idea', date_trunc('hour', now()) + interval '1 minute', 't')"],
    ["a reason that is not a code", "INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour) VALUES ($1, 'withheld', 'Some Text!', 'idea', date_trunc('hour', now()))"],
    ["steps that are not an array", "INSERT INTO public_records (entry_id, state, kind, captured_hour, body, steps) VALUES ($1, 'published', 'idea', date_trunc('hour', now()), 't', '{}')"],
    ["checks that are not an array", "INSERT INTO public_records (entry_id, state, kind, captured_hour, body, checks) VALUES ($1, 'published', 'idea', date_trunc('hour', now()), 't', '{}')"],
    ["withheld with checks", "INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour, checks) VALUES ($1, 'withheld', 'x', 'idea', date_trunc('hour', now()), '[{}]')"],
    ["withheld with a check-list version", "INSERT INTO public_records (entry_id, state, withheld_reason, kind, captured_hour, checks_version) VALUES ($1, 'withheld', 'x', 'idea', date_trunc('hour', now()), 1)"],
    ["a check-list version below 1", "INSERT INTO public_records (entry_id, state, kind, captured_hour, body, checks_version) VALUES ($1, 'published', 'idea', date_trunc('hour', now()), 't', 0)"],
  ])("rejects %s", async (_name, sql) => {
    const id = await entry();
    await expect(db.query(sql, [id])).rejects.toThrow();
  });

  it("v_public_records shows only published rows, with a public id and no entry id or reason", async () => {
    const pub = await entry();
    const held = await entry();
    await publish(pub, "shown");
    await withhold(held);
    const { rows } = await as("web_public", () => db.query<{ body: string; public_id: string }>("SELECT * FROM v_public_records"));
    const cols = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'v_public_records' ORDER BY ordinal_position");
    expect(cols.rows.map((c) => c.column_name)).toEqual(["public_id", "captured_hour", "kind", "body", "steps", "checks", "checks_version"]);
    expect(rows.map((r) => r.body)).toEqual(["shown"]);
    expect(rows[0]!.public_id).not.toBe(pub);
  });

  it("v_public_log_counts counts published, withheld and entries awaiting review", async () => {
    const before = (await as("web_public", () => db.query<{ published: number; withheld: number; awaiting_review: number }>("SELECT * FROM v_public_log_counts"))).rows[0]!;
    const waiting = await entry();
    await db.query("INSERT INTO agent_events (agent, event_type, entry_id) VALUES ('router', 'captured', $1)", [waiting]);
    const reviewed = await entry();
    await db.query("INSERT INTO agent_events (agent, event_type, entry_id) VALUES ('router', 'captured', $1), ('router', 'confirmed', $1)", [reviewed]);
    await publish(reviewed);
    const after = (await as("web_public", () => db.query<{ published: number; withheld: number; awaiting_review: number }>("SELECT * FROM v_public_log_counts"))).rows[0]!;
    expect(Number(after.published)).toBe(Number(before.published) + 1);
    expect(Number(after.withheld)).toBe(Number(before.withheld));
    expect(Number(after.awaiting_review)).toBe(Number(before.awaiting_review) + 1);
  });

  it("web_public cannot read the table or entries; web_rw writes but cannot delete", async () => {
    await expect(as("web_public", () => db.query("SELECT * FROM public_records"))).rejects.toThrow();
    await expect(as("web_public", () => db.query("SELECT * FROM entry_public"))).rejects.toThrow();
    await expect(as("web_public", () => db.query("SELECT * FROM entries"))).rejects.toThrow();
    const id = await entry();
    await as("web_rw", () => publish(id));
    await expect(as("web_rw", () => db.query("DELETE FROM public_records"))).rejects.toThrow();
    await expect(as("orch_rw", () => db.query("SELECT * FROM v_public_records"))).rejects.toThrow();
  });

  it("is deleted with its entry", async () => {
    const id = await entry();
    await publish(id);
    await db.query("DELETE FROM entries WHERE id = $1", [id]);
    expect((await db.query("SELECT 1 FROM public_records WHERE entry_id = $1", [id])).rows).toHaveLength(0);
  });
});
