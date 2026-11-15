import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callEventStatement } from "../../core/src/models/ledger";
import type { CallEvent } from "../../core/src/models/types";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0019 call records (AR3). The statements are the ones every writer runs (core models/ledger.ts),
// here as a non-superuser member of pipeline_rw (the narrowest writer) and of web_rw.
const PIPE = "pipe_ledger_app";
const WEB = "web_ledger_app";
const ESSAY = "00000000-0000-4000-8000-000000000001";

const start = (callId: string, extra: Partial<CallEvent> = {}): CallEvent => ({
  phase: "start", callId, provider: "acme", model: "m-req", operation: "classify",
  tag: { purpose: "categorize", subject: { kind: "essay", id: ESSAY } }, ...extra,
} as CallEvent);
const end = (callId: string, outcome: "reported" | "unknown" | "rejected", tokens: [number | null, number | null] = [null, null]): CallEvent => ({
  phase: "end", callId, provider: "acme", model: "m-ret", operation: "classify", outcome,
  inputTokens: tokens[0], outputTokens: tokens[1],
  tag: { purpose: "categorize", subject: { kind: "essay", id: ESSAY } },
});

describe("0019 usage accounting", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await db.exec(`CREATE ROLE ${PIPE} LOGIN; GRANT pipeline_rw TO ${PIPE}; CREATE ROLE ${WEB} LOGIN; GRANT web_rw TO ${WEB};`);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function as(role: string, agent: string, e: CallEvent): Promise<void> {
    const s = callEventStatement(agent, e);
    await db.exec(`SET ROLE ${role}`);
    try {
      await db.query(s.text, s.values);
    } finally {
      await db.exec("RESET ROLE");
    }
  }
  const row = async (key: string) =>
    (await db.query<Record<string, unknown>>(
      `SELECT agent, model, input_tokens, output_tokens, outcome, purpose, subject_kind, subject_id, task_id
         FROM usage_events WHERE dedupe_key = $1`, [key])).rows;

  it("is migration 0019", async () => {
    expect((await loadMigrations()).find((m) => m.version === "0019")?.name).toBe("usage_accounting");
  });

  it("pipeline_rw starts and completes a call record: one row, linked to the essay", async () => {
    await as(PIPE, "pipeline", start("c1"));
    expect(await row("call:c1")).toEqual([{
      agent: "pipeline", model: "m-req", input_tokens: null, output_tokens: null, outcome: "started",
      purpose: "categorize", subject_kind: "essay", subject_id: ESSAY, task_id: null,
    }]);
    await as(PIPE, "pipeline", end("c1", "reported", [10, 2]));
    expect(await row("call:c1")).toMatchObject([{ model: "m-ret", input_tokens: 10, output_tokens: 2, outcome: "reported" }]);
  });

  it("duplicates write one row: a second start or end changes nothing", async () => {
    await as(PIPE, "pipeline", start("c2"));
    await as(PIPE, "pipeline", start("c2"));
    await as(PIPE, "pipeline", end("c2", "reported", [5, 5]));
    await as(PIPE, "pipeline", end("c2", "reported", [99, 99]));
    await as(PIPE, "pipeline", end("c2", "unknown"));
    expect(await row("call:c2")).toMatchObject([{ input_tokens: 5, output_tokens: 5, outcome: "reported" }]);
  });

  it("unknown keeps NULL tokens; a late report completes it; an end without its start inserts the row", async () => {
    await as(WEB, "router", start("c3"));
    await as(WEB, "router", end("c3", "unknown"));
    expect(await row("call:c3")).toMatchObject([{ input_tokens: null, output_tokens: null, outcome: "unknown" }]);
    await as(WEB, "router", end("c3", "reported", [7, 1]));
    expect(await row("call:c3")).toMatchObject([{ input_tokens: 7, output_tokens: 1, outcome: "reported" }]);
    await as(WEB, "router", end("c4", "rejected"));
    expect(await row("call:c4")).toMatchObject([{ outcome: "rejected", input_tokens: null }]);
    await as(WEB, "router", end("c4", "reported", [1, 1]));
    expect(await row("call:c4")).toMatchObject([{ outcome: "rejected" }]);
  });

  it("rows the live build writes default to outcome reported with no purpose", async () => {
    await db.query("INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens) VALUES ('model', 'router', 'acme', 'm', 1, 1)");
    const { rows } = await db.query<{ outcome: string; purpose: string | null }>(
      "SELECT outcome, purpose FROM usage_events WHERE dedupe_key IS NULL AND agent = 'router'");
    expect(rows).toEqual([{ outcome: "reported", purpose: null }]);
  });

  it("checks refuse text in purpose and subject, half a subject, an unknown outcome or agent", async () => {
    const bad = [
      "INSERT INTO usage_events (kind, agent, provider, model, purpose) VALUES ('model', 'router', 'a', 'm', 'Has Spaces')",
      "INSERT INTO usage_events (kind, agent, provider, model, subject_kind, subject_id) VALUES ('model', 'router', 'a', 'm', 'entry', 'two words')",
      "INSERT INTO usage_events (kind, agent, provider, model, subject_kind) VALUES ('model', 'router', 'a', 'm', 'entry')",
      "INSERT INTO usage_events (kind, agent, provider, model, outcome) VALUES ('model', 'router', 'a', 'm', 'maybe')",
      "INSERT INTO usage_events (kind, agent, provider, model) VALUES ('model', 'nobody', 'a', 'm')",
    ];
    for (const sql of bad) await expect(db.query(sql)).rejects.toThrow(/check constraint/);
  });

  it("pipeline_rw reads no tokens, costs or other rows' data", async () => {
    await db.exec(`SET ROLE ${PIPE}`);
    try {
      await expect(db.query("SELECT input_tokens FROM usage_events")).rejects.toThrow(/permission denied/);
      await expect(db.query("SELECT cost_usd FROM usage_events")).rejects.toThrow(/permission denied/);
      await expect(db.query("DELETE FROM usage_events")).rejects.toThrow(/permission denied/);
      await expect(db.query("UPDATE usage_events SET cost_usd = 0")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
