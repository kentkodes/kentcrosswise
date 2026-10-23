// PREVIEW AND LOCAL ONLY (runs from the seed; prod never seeds: deploy.yml only migrates).
// Previews connect as the Neon branch owner, which created web_rw/web_public in migration 0001.
// On Postgres 16+ the creator of a role gets ADMIN on it but not SET (createrole_self_grant is empty
// by default), so the web app's `SET LOCAL ROLE web_public` was refused. Granting the roles to the
// current user with SET lets it switch to them. Idempotent (a repeated GRANT only updates options),
// and harmless for a superuser such as PGlite's postgres user.
import type { SqlClient } from "../src/client";

export const PREVIEW_SESSION_ROLES = ["web_rw", "web_public"] as const;

export async function grantPreviewSessionRoles(db: SqlClient): Promise<void> {
  await db.exec(`DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT web_rw, web_public TO %I WITH SET TRUE', current_user);
  ELSE
    EXECUTE format('GRANT web_rw, web_public TO %I', current_user);
  END IF;
END
$$;`);
}
