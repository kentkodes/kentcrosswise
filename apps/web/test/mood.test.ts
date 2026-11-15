// H6 mood scoring: strict reply validation, the spend cap, provider errors, truncated replies, re-score replaces,
// a body edited during the call, delete cascade. PGlite and FakeProvider only; no model is called for real.
import type { PGlite } from "@electric-sql/pglite";
import { FakeProvider } from "@kcw/core/models";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiaryEntry, deleteDiaryEntry, getDiary, updateDiaryBody } from "../src/server/diary";
import { runAs } from "../src/server/db";
import { MOOD_INSTRUCTIONS, parseMoodReply, scoreDiaryEntry } from "../src/server/mood";
import type { DbRun } from "../src/server/router";
import { freshDb, pglitePool } from "./pglite";

const GOOD = { energy: 0.6, stress: 0.2, happiness: 0.7, satisfaction: 0.5, sadness: 0.1, anger: 0, anxiety: 0.3, gratitude: 1, sentiment: -0.25 };
const reply = (o: Record<string, unknown> = {}) => JSON.stringify({ ...GOOD, ...o });

describe("parseMoodReply", () => {
  it("accepts one object with the nine fields, including the bounds", () => {
    const r = parseMoodReply(` ${reply({ sentiment: -1, energy: 0, gratitude: 1 })}\n`);
    expect(r.ok && r.values.sentiment).toBe(-1);
  });

  const bad: [string, string][] = [
    ["prose", "The mood is happy."],
    ["a code fence", "```json\n" + reply() + "\n```"],
    ["an array", "[1,2]"],
    ["null", "null"],
    ["a missing field", JSON.stringify({ ...GOOD, gratitude: undefined })],
    ["an extra field", reply({ note: 1 })],
    ["a string number", reply({ energy: "0.5" })],
    ["null value", reply({ stress: null })],
    ["above one", reply({ anger: 1.01 })],
    ["below zero", reply({ sadness: -0.01 })],
    ["sentiment above one", reply({ sentiment: 1.2 })],
    ["sentiment below minus one", reply({ sentiment: -1.0001 })],
    ["empty", ""],
  ];
  it.each(bad)("rejects %s", (_name, text) => {
    expect(parseMoodReply(text).ok).toBe(false);
  });

  it("rejects a non-finite number (JSON cannot carry one, so it is a parse failure)", () => {
    expect(parseMoodReply('{"energy": NaN}').ok).toBe(false);
    expect(parseMoodReply('{"energy": 1e999}').ok).toBe(false);
  });
});

describe("scoreDiaryEntry (web_rw on PGlite)", () => {
  let pg: PGlite;
  const run: DbRun = (fn) => runAs(pglitePool(pg), "web_rw", fn);
  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => pg.query<R>(sql, params);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });
  afterEach(() => log.mockClear());

  const newEntry = (body = "A quiet day, mostly good.") => run((db) => createDiaryEntry(db, body));
  const scoreCount = async (id: string) => String((await q<{ n: number | string }>("SELECT count(*) AS n FROM mood_scores WHERE diary_entry_id = $1", [id])).rows[0]!.n).toString();

  it("stores the nine numbers and the returned model id, and sends the instructions and only the body", async () => {
    const id = await newEntry("Synthetic body one");
    const provider = new FakeProvider({ complete: { text: reply(), model: "deepseek-returned-1" } });
    await expect(scoreDiaryEntry(run, id, provider)).resolves.toBe("scored");
    const row = await run((db) => getDiary(db, id));
    expect(row?.mood).toMatchObject({ ...GOOD, model: "deepseek-returned-1" });
    expect(provider.calls).toEqual([{ op: "complete", input: "Synthetic body one" }]);
    expect(MOOD_INSTRUCTIONS).toContain("exactly these nine numeric fields");
  });

  it("re-scoring replaces the row (one per entry) with the new values and model", async () => {
    const id = await newEntry();
    await scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: reply(), model: "m1" } }));
    await scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: reply({ energy: 0.9, sentiment: 0.5 }), model: "m2" } }));
    expect(await scoreCount(id)).toBe("1");
    const mood = (await run((db) => getDiary(db, id)))?.mood;
    expect(mood).toMatchObject({ energy: 0.9, sentiment: 0.5, model: "m2" });
  });

  it("a failed re-score keeps the old score", async () => {
    const id = await newEntry();
    await scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: reply({ energy: 0.4 }) } }));
    await expect(scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: "nope" } }))).resolves.toBe("failed");
    expect((await run((db) => getDiary(db, id)))?.mood?.energy).toBe(0.4);
  });

  it.each([
    ["an out-of-range value", { text: reply({ stress: 2 }) }],
    ["a parse failure", { text: "not json" }],
    ["a missing field", { text: JSON.stringify({ energy: 0.5 }) }],
    ["a truncated reply", { text: reply().slice(0, 30), stop: "max_tokens" as const }],
    ["a complete-looking reply cut off by max_tokens", { text: reply(), stop: "max_tokens" as const }],
    ["a refusal", { text: reply(), stop: "refusal" as const }],
  ])("%s is a failed score: nothing is stored and nothing is clamped", async (_name, answer) => {
    const id = await newEntry();
    await expect(scoreDiaryEntry(run, id, new FakeProvider({ complete: answer }))).resolves.toBe("failed");
    expect(await scoreCount(id)).toBe("0");
  });

  it("a provider error is a failed score, logged by class only", async () => {
    const id = await newEntry("Secret text that must not be logged");
    const err = new TypeError("boom with Secret text that must not be logged");
    await expect(scoreDiaryEntry(run, id, new FakeProvider({ complete: err }))).resolves.toBe("failed");
    expect(await scoreCount(id)).toBe("0");
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("Secret");
  });

  it("does not log the reply text on a parse failure", async () => {
    const id = await newEntry();
    await scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: "private model words" } }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("does not call the model once the monthly spend cap is reached", async () => {
    await q(
      "INSERT INTO usage_events (kind, agent, provider, model, input_tokens, output_tokens, cost_usd) VALUES ('model', 'orchestrator', 'deepseek', 'deepseek-flash', 1, 1, 50)",
    );
    try {
      const id = await newEntry();
      const provider = new FakeProvider({ complete: { text: reply() } });
      await expect(scoreDiaryEntry(run, id, provider)).resolves.toBe("cap");
      expect(provider.calls).toHaveLength(0);
      expect(await scoreCount(id)).toBe("0");
    } finally {
      await q("DELETE FROM usage_events WHERE agent = 'orchestrator'");
    }
  });

  it("returns not-found for an unknown entry without calling the model", async () => {
    const provider = new FakeProvider({ complete: { text: reply() } });
    await expect(scoreDiaryEntry(run, "8f14e45f-ceea-4671-9d3f-0b1f5c1e2a3b", provider)).resolves.toBe("not-found");
    expect(provider.calls).toHaveLength(0);
  });

  it("drops the score when the body changed during the call (and when the entry was deleted)", async () => {
    const id = await newEntry("before");
    const edit = new FakeProvider({
      complete: async () => {
        await run((db) => updateDiaryBody(db, id, "after"));
        return { text: reply() };
      },
    });
    await expect(scoreDiaryEntry(run, id, edit)).resolves.toBe("changed");
    expect(await scoreCount(id)).toBe("0");

    const gone = new FakeProvider({
      complete: async () => {
        await run((db) => deleteDiaryEntry(db, id));
        return { text: reply() };
      },
    });
    await expect(scoreDiaryEntry(run, id, gone)).resolves.toBe("changed");
    expect(await scoreCount(id)).toBe("0");
  });

  it("deleting an entry deletes its score", async () => {
    const id = await newEntry();
    await scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: reply() } }));
    expect(await scoreCount(id)).toBe("1");
    await expect(run((db) => deleteDiaryEntry(db, id))).resolves.toBe(true);
    expect(await scoreCount(id)).toBe("0");
  });

  it("writes no usage_events of its own (the provider callback does that)", async () => {
    const id = await newEntry();
    await scoreDiaryEntry(run, id, new FakeProvider({ complete: { text: reply() } }));
    const { rows } = await q<{ n: number | string }>("SELECT count(*) AS n FROM usage_events");
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
