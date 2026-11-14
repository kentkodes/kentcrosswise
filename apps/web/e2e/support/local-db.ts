// Local Playwright only (no BASE_URL): an in-memory Postgres (PGlite) with the migrations and the
// synthetic seed, served over the wire protocol on 127.0.0.1:<PW_DB_PORT>. The local preview build
// reaches it through KCW_LOCAL_DATABASE_URL (playwright.config.ts). Synthetic data only.
// Run: node ../../node_modules/tsx/dist/cli.mjs e2e/support/local-db.ts (from apps/web)
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { seedDemo } from "@kcw/db/seeds";
import { servePglite } from "./pg-socket";

const port = Number(process.env.PW_DB_PORT ?? 3918);

const pg = await PGlite.create();
const db = fromPglite(pg);
await migrate(db);
await seedDemo(db, { seed: "local-e2e", days: 5, contacts: 4 });
// H3 routing: two entries the router could not decide (needs_owner), each with its open routing inbox item.
// Routing is off in this run (no models secret), so nothing else creates them.
for (const text of ["e2e route seed one: a note about Sam", "e2e route seed two: a plan for the trip"]) {
  const { rows } = await pg.query<{ id: string }>(
    "INSERT INTO entries (source, raw_text, route_kind, route_confidence, route_model, routed_by, status) VALUES ('web', $1, 'crm_note', 0.42, 'deepseek-flash', 'model', 'needs_owner') RETURNING id",
    [text],
  );
  await pg.query("INSERT INTO inbox_items (kind, ref_table, ref_id, title) VALUES ('routing', 'entries', $1, $2)", [
    rows[0]!.id,
    `Routing: ${text}`,
  ]);
}
const server = await servePglite(pg, { port });
console.log(`[local-db] PGlite listening on 127.0.0.1:${port}`);

const stop = () => {
  void server.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
