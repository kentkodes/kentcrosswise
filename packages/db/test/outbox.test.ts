import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// 0011 orchestrator_outbox and orchestrator_receipts (AR2 slice 1). Each role's real queries run as
// a non-superuser login that is a plain member of the group role, like relay_app, web_app and
// orch_app in prod (SET ROLE, as in relay-role.test.ts). The queries are the ones in
// agents/webhook-relay/src/store.ts, apps/web/src/server/outbox.ts, agents/orchestrator/src/sweeper/store.ts
// and agents/orchestrator/src/graph/receipts.ts.
const LOGINS = { relay_rw: "relay_test_app", web_rw: "web_test_app", orch_rw: "orch_test_app" } as const;
type Group = keyof typeof LOGINS;

describe("0011 orchestrator_outbox and orchestrator_receipts", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    for (const [group, login] of Object.entries(LOGINS)) await db.exec(`CREATE ROLE ${login} LOGIN; GRANT ${group} TO ${login};`);
  });
  afterAll(async () => {
    await pg.close();
  });

  async function as<T = Record<string, unknown>>(group: Group, sql: string, params?: unknown[]): Promise<T[]> {
    await db.exec(`SET ROLE ${LOGINS[group]}`);
    try {
      const { rows } = await db.query<{ su: boolean }>("SELECT rolsuper AS su FROM pg_roles WHERE rolname = current_user");
      expect(rows).toEqual([{ su: false }]);
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  }

  it("bounds its lock wait like 0007 and 0010 (first statement)", async () => {
    const m = (await loadMigrations()).find((x) => x.version === "0011");
    expect(m?.name).toBe("orchestrator_outbox");
    const first = m!.sql.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("--"));
    expect(first).toBe("SET LOCAL lock_timeout = '5s';");
  });

  it("has the spec's columns, key limits and the partial index", async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'orchestrator_outbox' ORDER BY ordinal_position`,
    );
    expect(rows.map((r) => `${r.column_name} ${r.data_type} ${r.is_nullable}`)).toEqual([
      "id bigint NO",
      "message_key text NO",
      "group_id text NO",
      "body text NO",
      "created_at timestamp with time zone NO",
      "sent_at timestamp with time zone YES",
      "attempts integer NO",
      "next_attempt_at timestamp with time zone NO",
      "last_error text YES",
    ]);
    const idx = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'orchestrator_outbox' AND indexname = 'orchestrator_outbox_unsent'",
    );
    expect(idx.rows[0]!.indexdef).toMatch(/\(id\) WHERE \(sent_at IS NULL\)/);
    await db.exec("INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ('k-1', 'task-1', '{}')");
    for (const sql of [
      "INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ('k-1', 'task-1', '{}')", // unique
      "INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ('', 'task-1', '{}')",
      `INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ('${"x".repeat(129)}', 'task-1', '{}')`,
      "INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES (NULL, 'task-1', '{}')",
    ]) await expect(db.exec(sql), sql).rejects.toThrow();
    await db.exec(`INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ('${"x".repeat(128)}', 'task-1', '{}')`);
    await db.exec("DELETE FROM orchestrator_outbox");
  });

  it("grants exactly the columns each role's queries use", async () => {
    const columns = await db.query<{ grantee: string; obj: string; priv: string }>(
      `SELECT a.grantee::regrole::text AS grantee, at.attname AS obj, a.privilege_type AS priv
         FROM pg_attribute at, aclexplode(at.attacl) a
        WHERE at.attrelid = 'public.orchestrator_outbox'::regclass ORDER BY 1, 3, 2`,
    );
    const by = (g: string, p: string) => columns.rows.filter((r) => r.grantee === g && r.priv === p).map((r) => r.obj).sort();
    expect(by("relay_rw", "INSERT")).toEqual(["body", "group_id", "message_key"]);
    expect(by("relay_rw", "SELECT")).toEqual(["id", "sent_at"]);
    expect(by("relay_rw", "UPDATE")).toEqual(["sent_at"]);
    expect(by("web_rw", "INSERT")).toEqual(["body", "group_id", "message_key"]);
    expect(by("web_rw", "SELECT")).toEqual(["message_key", "sent_at"]);
    expect(by("web_rw", "UPDATE")).toEqual(["sent_at"]);
    expect(by("orch_rw", "INSERT")).toEqual([]);
    expect(by("orch_rw", "SELECT")).toEqual(
      ["attempts", "body", "created_at", "group_id", "id", "message_key", "next_attempt_at", "sent_at"],
    );
    expect(by("orch_rw", "UPDATE")).toEqual(["attempts", "last_error", "next_attempt_at", "sent_at"]);
    // No table-level grant on either table except orch_rw's receipts, and nothing for the other roles.
    const tables = await db.query<{ rel: string; grantee: string; priv: string }>(
      `SELECT c.relname AS rel, a.grantee::regrole::text AS grantee, a.privilege_type AS priv
         FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relname IN ('orchestrator_outbox', 'orchestrator_receipts') AND a.grantee <> c.relowner ORDER BY 1, 2, 3`,
    );
    expect(tables.rows).toEqual([
      { rel: "orchestrator_receipts", grantee: "orch_rw", priv: "INSERT" },
      { rel: "orchestrator_receipts", grantee: "orch_rw", priv: "SELECT" },
    ]);
    for (const role of ["web_public", "pipeline_rw"]) {
      const { rows } = await db.query<{ any: boolean }>(
        `SELECT has_any_column_privilege($1, 'public.orchestrator_outbox', 'SELECT')
             OR has_any_column_privilege($1, 'public.orchestrator_outbox', 'INSERT')
             OR has_table_privilege($1, 'public.orchestrator_receipts', 'SELECT') AS any`,
        [role],
      );
      expect(rows, role).toEqual([{ any: false }]);
    }
  });

  it("relay_rw runs its claim-and-enqueue statement and marks the row sent, nothing more", async () => {
    const claim = `WITH c AS (
        INSERT INTO inbound_events (delivery_id, source) VALUES ($1, $2)
        ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id)
      INSERT INTO orchestrator_outbox (message_key, group_id, body)
      SELECT delivery_id, $3::text, $4::text FROM c RETURNING id`;
    const first = await as<{ id: string }>("relay_rw", claim, ["d-1", "github", "task-1", '{"a":1}']);
    expect(first).toHaveLength(1);
    expect(await as("relay_rw", claim, ["d-1", "github", "task-1", '{"a":1}'])).toEqual([]); // duplicate: no row
    await as("relay_rw", "UPDATE orchestrator_outbox SET sent_at = now() WHERE id = $1 AND sent_at IS NULL", [first[0]!.id]);
    const { rows } = await db.query<{ message_key: string; sent: boolean; claims: number }>(
      `SELECT message_key, sent_at IS NOT NULL AS sent, (SELECT count(*)::int FROM inbound_events WHERE delivery_id = 'd-1') AS claims
         FROM orchestrator_outbox`,
    );
    expect(rows).toEqual([{ message_key: "d-1", sent: true, claims: 1 }]);
    const denied = [
      "SELECT * FROM orchestrator_outbox",
      "SELECT body FROM orchestrator_outbox",
      "SELECT message_key FROM orchestrator_outbox",
      "UPDATE orchestrator_outbox SET attempts = 5",
      "UPDATE orchestrator_outbox SET body = 'x'",
      "DELETE FROM orchestrator_outbox",
      "SELECT * FROM orchestrator_receipts",
      "INSERT INTO orchestrator_receipts (message_key) VALUES ('x')",
      // The release is gone: a claim is permanent.
      "DELETE FROM inbound_events WHERE delivery_id = 'd-1'",
    ];
    for (const sql of denied) await expect(as("relay_rw", sql), sql).rejects.toThrow(/permission denied/);
  });

  it("web_rw inserts its row and marks it sent by key, nothing more", async () => {
    await as("web_rw", "INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ($1, $2, $3)", ["task-created-9", "task-9", "{}"]);
    await as("web_rw", "UPDATE orchestrator_outbox SET sent_at = now() WHERE message_key = $1 AND sent_at IS NULL", ["task-created-9"]);
    const { rows } = await db.query<{ sent: boolean }>("SELECT sent_at IS NOT NULL AS sent FROM orchestrator_outbox WHERE message_key = 'task-created-9'");
    expect(rows).toEqual([{ sent: true }]);
    const denied = [
      "SELECT * FROM orchestrator_outbox",
      "SELECT body FROM orchestrator_outbox",
      "UPDATE orchestrator_outbox SET attempts = 5",
      "UPDATE orchestrator_outbox SET last_error = 'x'",
      "DELETE FROM orchestrator_outbox",
      "SELECT * FROM orchestrator_receipts",
      "INSERT INTO orchestrator_receipts (message_key) VALUES ('x')",
    ];
    for (const sql of denied) await expect(as("web_rw", sql), sql).rejects.toThrow(/permission denied/);
  });

  it("orch_rw runs the sweeper's drain and the consumer's receipts, and cannot insert or delete outbox rows", async () => {
    await db.exec("DELETE FROM orchestrator_outbox");
    await db.exec(
      `INSERT INTO orchestrator_outbox (message_key, group_id, body, created_at) VALUES
         ('o-1', 'task-1', 'b1', now() - interval '5 minutes'), ('o-2', 'task-1', 'b2', now() - interval '5 minutes'),
         ('o-3', 'task-2', 'b3', now())`,
    );
    const list = `SELECT o.id, o.message_key, o.group_id, o.body FROM orchestrator_outbox o
          WHERE o.sent_at IS NULL AND o.next_attempt_at <= now() AND o.created_at <= now() - make_interval(mins => $2)
            AND NOT EXISTS (SELECT 1 FROM orchestrator_outbox e
                             WHERE e.group_id = o.group_id AND e.sent_at IS NULL AND e.id < o.id AND e.next_attempt_at > now())
          ORDER BY o.id LIMIT $1`;
    const due = await as<{ id: string; message_key: string }>("orch_rw", list, [200, 2]);
    expect(due.map((r) => r.message_key)).toEqual(["o-1", "o-2"]);
    await as("orch_rw", "UPDATE orchestrator_outbox SET sent_at = now() WHERE id = $1 AND sent_at IS NULL", [due[0]!.id]);
    await as(
      "orch_rw",
      `UPDATE orchestrator_outbox
          SET attempts = attempts + 1, last_error = $2,
              next_attempt_at = now() + least(make_interval(mins => $3) * power(2, least(attempts, 10)), make_interval(hours => $4))
        WHERE id = $1`,
      [due[1]!.id, "ThrottlingException", 15, 6],
    );
    const { rows } = await db.query<{ message_key: string; sent: boolean; attempts: number; last_error: string | null }>(
      "SELECT message_key, sent_at IS NOT NULL AS sent, attempts, last_error FROM orchestrator_outbox ORDER BY id",
    );
    expect(rows).toEqual([
      { message_key: "o-1", sent: true, attempts: 0, last_error: null },
      { message_key: "o-2", sent: false, attempts: 1, last_error: "ThrottlingException" },
      { message_key: "o-3", sent: false, attempts: 0, last_error: null },
    ]);

    expect(await as("orch_rw", "SELECT 1 FROM orchestrator_receipts WHERE message_key = $1", ["d-1"])).toEqual([]);
    const record = "INSERT INTO orchestrator_receipts (message_key) VALUES ($1) ON CONFLICT (message_key) DO NOTHING";
    await as("orch_rw", record, ["d-1"]);
    await as("orch_rw", record, ["d-1"]);
    expect(await as("orch_rw", "SELECT 1 FROM orchestrator_receipts WHERE message_key = $1", ["d-1"])).toHaveLength(1);

    const denied = [
      "INSERT INTO orchestrator_outbox (message_key, group_id, body) VALUES ('z', 'task-1', '{}')",
      "UPDATE orchestrator_outbox SET body = 'x'",
      "UPDATE orchestrator_outbox SET message_key = 'x'",
      "DELETE FROM orchestrator_outbox",
      "UPDATE orchestrator_receipts SET message_key = 'x'",
      "DELETE FROM orchestrator_receipts",
    ];
    for (const sql of denied) await expect(as("orch_rw", sql), sql).rejects.toThrow(/permission denied/);
  });
});
