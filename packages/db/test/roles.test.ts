import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantPreviewSessionRoles } from "../seeds/roles";
import { seedDemo } from "../seeds/seed";
import { fromPglite, type SqlClient } from "../src/index";
import { freshDb } from "./helpers";

// Reproduces a Neon preview branch: the login user is not a superuser and holds ADMIN on the web
// roles but neither SET nor INHERIT (Postgres 16+ creator grant with createrole_self_grant empty).
// SET ROLE is checked against the session user, so the test switches the session authorization.
describe("grantPreviewSessionRoles", () => {
  let pg: PGlite;
  let db: SqlClient;
  beforeAll(async () => {
    ({ pg, db } = await freshDb());
    await pg.exec(`
      CREATE ROLE branch_owner NOLOGIN CREATEROLE;
      GRANT web_rw, web_public TO branch_owner WITH ADMIN TRUE, SET FALSE, INHERIT FALSE;
      GRANT CREATE ON SCHEMA public TO branch_owner;
    `);
  });
  afterAll(async () => {
    await pg.close();
  });

  const asOwner = async <T>(fn: () => Promise<T>): Promise<T> => {
    await pg.exec("SET SESSION AUTHORIZATION branch_owner");
    try {
      return await fn();
    } finally {
      await pg.exec("RESET ROLE; RESET SESSION AUTHORIZATION");
    }
  };

  it("the server is Postgres 16+, so WITH SET is the path under test", async () => {
    const { rows } = await pg.query<{ v: number }>("SELECT current_setting('server_version_num')::int AS v");
    expect(rows[0]!.v).toBeGreaterThanOrEqual(160000);
  });

  it("without the grant the branch owner cannot SET ROLE web_public (the preview failure)", async () => {
    await expect(asOwner(() => pg.exec("SET ROLE web_public"))).rejects.toThrow(/permission denied/);
  });

  it("after the grant it can, twice in a row (idempotent)", async () => {
    await asOwner(() => grantPreviewSessionRoles(db));
    await asOwner(() => grantPreviewSessionRoles(db));
    for (const role of ["web_public", "web_rw"]) {
      const who = await asOwner(async () => {
        await pg.exec(`SET ROLE ${role}`);
        return (await pg.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
      });
      expect(who).toBe(role);
    }
  });

  it("grants nothing beyond membership in the two web roles", async () => {
    const { rows } = await pg.query<{ role: string }>(
      `SELECT r.rolname AS role FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
        WHERE u.rolname = 'branch_owner' AND m.set_option ORDER BY 1`,
    );
    expect([...new Set(rows.map((r) => r.role))]).toEqual(["web_public", "web_rw"]);
  });

  it("is harmless for a superuser (PGlite's postgres user) and runs inside seedDemo", async () => {
    await expect(grantPreviewSessionRoles(db)).resolves.toBeUndefined();
    const fresh = await freshDb();
    await expect(seedDemo(fromPglite(fresh.pg), { seed: "roles", days: 2, contacts: 2 })).resolves.toBeDefined();
    await fresh.pg.close();
  });
});
