import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addIdea,
  addTodo,
  deleteIdea,
  deleteTodo,
  ListInputError,
  listIdeas,
  listTodos,
  MAX_ITEM_CHARS,
  parseItemText,
  setIdeaStatus,
  setTodoDone,
} from "../src/server/lists";
import { runAs, type Queryable } from "../src/server/db";
import { freshDb, pglitePool } from "./pglite";

describe("parseItemText", () => {
  it("rejects missing, empty and whitespace-only text", () => {
    expect(parseItemText(undefined)).toEqual({ ok: false, error: "empty" });
    expect(parseItemText("")).toEqual({ ok: false, error: "empty" });
    expect(parseItemText(" \t\n ")).toEqual({ ok: false, error: "empty" });
  });

  it("trims the text it keeps", () => {
    expect(parseItemText("  buy milk  ")).toEqual({ ok: true, text: "buy milk" });
  });

  it("accepts exactly the maximum length and rejects one more", () => {
    expect(MAX_ITEM_CHARS).toBe(2000);
    expect(parseItemText("x".repeat(2000))).toEqual({ ok: true, text: "x".repeat(2000) });
    expect(parseItemText("x".repeat(2001))).toEqual({ ok: false, error: "too-long" });
  });

  it("counts characters, not UTF-16 units", () => {
    expect(parseItemText("\u{1F600}".repeat(2000))).toEqual({ ok: true, text: "\u{1F600}".repeat(2000) });
    expect(parseItemText("\u{1F600}".repeat(2001))).toEqual({ ok: false, error: "too-long" });
  });
});

describe("todos and ideas as web_rw", () => {
  let pg: PGlite;
  const asRw = <T>(fn: (db: Queryable) => Promise<T>) => runAs(pglitePool(pg), "web_rw", fn);

  beforeAll(async () => {
    pg = await freshDb();
  });
  afterAll(async () => {
    await pg.close();
  });

  it("adds an open todo and lists it with its fields", async () => {
    const id = await asRw((db) => addTodo(db, "  call the bank  "));
    const rows = await asRw((db) => listTodos(db));
    const row = rows.find((r) => r.id === id);
    expect(row).toMatchObject({ body: "call the bank", done: false, fromCapture: false });
  });

  it("refuses an empty or too long todo and stores nothing", async () => {
    await expect(asRw((db) => addTodo(db, "   "))).rejects.toMatchObject({ code: "empty" });
    await expect(asRw((db) => addTodo(db, "x".repeat(2001)))).rejects.toMatchObject({ code: "too-long" });
    await expect(asRw((db) => addTodo(db, "x".repeat(2001)))).rejects.toBeInstanceOf(ListInputError);
  });

  it("lists open todos before done ones, oldest first within each group", async () => {
    await pg.query(
      `INSERT INTO todos (body, done, created_at) VALUES
         ('old done', true, '2021-01-01T00:00:00Z'),
         ('old open', false, '2021-01-02T00:00:00Z'),
         ('new open', false, '2021-03-01T00:00:00Z'),
         ('older done', true, '2020-12-01T00:00:00Z')`,
    );
    const bodies = (await asRw((db) => listTodos(db))).map((r) => r.body);
    const fixtures = ["old done", "old open", "new open", "older done"];
    const seen = bodies.filter((b) => fixtures.includes(b));
    expect(seen).toEqual(["old open", "new open", "older done", "old done"]);
    const firstDone = bodies.findIndex((b) => b === "older done");
    expect(bodies.slice(0, firstDone).every((b) => !["old done", "older done"].includes(b))).toBe(true);
  });

  it("marks a todo done and undoes it", async () => {
    const id = await asRw((db) => addTodo(db, "toggle me"));
    await asRw((db) => setTodoDone(db, id, true));
    expect((await asRw((db) => listTodos(db))).find((r) => r.id === id)?.done).toBe(true);
    await asRw((db) => setTodoDone(db, id, false));
    expect((await asRw((db) => listTodos(db))).find((r) => r.id === id)?.done).toBe(false);
  });

  it("shows todos created from a capture in the same list, marked fromCapture", async () => {
    const { rows } = await pg.query<{ id: string }>(
      "INSERT INTO entries (source, raw_text) VALUES ('web', 'a captured plan') RETURNING id",
    );
    await pg.query("INSERT INTO todos (entry_id, body) VALUES ($1, 'from capture todo')", [rows[0]!.id]);
    const row = (await asRw((db) => listTodos(db))).find((r) => r.body === "from capture todo");
    expect(row?.fromCapture).toBe(true);
  });

  it("deletes a todo, and a missing or malformed id is not found", async () => {
    const id = await asRw((db) => addTodo(db, "delete me"));
    await asRw((db) => deleteTodo(db, id));
    expect((await asRw((db) => listTodos(db))).some((r) => r.id === id)).toBe(false);
    await expect(asRw((db) => deleteTodo(db, id))).rejects.toMatchObject({ code: "not-found" });
    await expect(asRw((db) => setTodoDone(db, "not-a-uuid", true))).rejects.toMatchObject({ code: "not-found" });
    await expect(asRw((db) => deleteTodo(db, undefined))).rejects.toMatchObject({ code: "not-found" });
  });

  it("adds ideas that list newest first, with status open by default", async () => {
    const first = await asRw((db) => addIdea(db, "an older idea"));
    await pg.query("UPDATE ideas SET created_at = '2021-01-01T00:00:00Z' WHERE id = $1", [first]);
    const second = await asRw((db) => addIdea(db, "a newer idea"));
    await pg.query("UPDATE ideas SET created_at = '2021-06-01T00:00:00Z' WHERE id = $1", [second]);
    const rows = await asRw((db) => listIdeas(db));
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(second)).toBeLessThan(ids.indexOf(first));
    expect(rows.find((r) => r.id === second)).toMatchObject({ body: "a newer idea", status: "open", fromCapture: false });
  });

  it("changes an idea to done, dropped and back to open", async () => {
    const id = await asRw((db) => addIdea(db, "change my status"));
    for (const status of ["done", "dropped", "open"] as const) {
      await asRw((db) => setIdeaStatus(db, id, status));
      expect((await asRw((db) => listIdeas(db))).find((r) => r.id === id)?.status).toBe(status);
    }
  });

  it("refuses an unknown idea status and leaves the idea alone", async () => {
    const id = await asRw((db) => addIdea(db, "keep my status"));
    await expect(asRw((db) => setIdeaStatus(db, id, "archived"))).rejects.toMatchObject({ code: "invalid-status" });
    await expect(asRw((db) => setIdeaStatus(db, id, undefined))).rejects.toMatchObject({ code: "invalid-status" });
    expect((await asRw((db) => listIdeas(db))).find((r) => r.id === id)?.status).toBe("open");
  });

  it("deletes an idea, and a missing one is not found", async () => {
    const id = await asRw((db) => addIdea(db, "throw me away"));
    await asRw((db) => deleteIdea(db, id));
    expect((await asRw((db) => listIdeas(db))).some((r) => r.id === id)).toBe(false);
    await expect(asRw((db) => setIdeaStatus(db, id, "done"))).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses an empty idea and stores nothing", async () => {
    await expect(asRw((db) => addIdea(db, ""))).rejects.toMatchObject({ code: "empty" });
  });
});
