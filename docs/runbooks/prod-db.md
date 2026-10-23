# Runbook: wire the prod Neon database (owner)

For the owner. Connects the empty Neon project `kentcrosswise` (AWS us-east-1) to prod: one migrator login for `deploy.yml`, one login per runtime, and their connection strings in Secrets Manager (DESIGN §3.4, §6). The Liaison runs the checks in step 5.

Commands are PowerShell. **Never paste a password or connection string into chat, a file or a command line.** Passwords are generated on your machine and only ever pasted into the Neon SQL Editor and the Secrets Manager console.

## Names

Migration 0001 creates NOLOGIN **group roles** (`web_rw`, `web_public`, `orch_rw`, `pipeline_rw`, `migrator`). Nothing logs in as them: each runtime has a **login user** that is a member of one group role. Login users end in `_app` so they never clash with a group role name.

| Login user | Created in | Member of | Secret, key | Endpoint |
|---|---|---|---|---|
| `migrator_app` | Neon console (step 1) | owns the database | `kcw/prod/migrator`, `db_url` | direct |
| `web_app` | SQL (step 3) | `web_rw` | `kcw/prod/web`, `db_url` | pooled |
| `web_public_app` | SQL (step 3) | `web_public` | `kcw/prod/web`, `db_url_public` | pooled |
| `orch_app` | SQL (step 3) | `orch_rw` | `kcw/prod/orchestrator`, `db_url` | pooled |
| `relay_app` | SQL (step 3) | `orch_rw` for now (step 3.3) | `kcw/prod/relay`, `db_url` | pooled |
| `pipeline_app` | later | `pipeline_rw` | `kcw/prod/pipeline`, `db_url` | pooled |

`kcw/prod/pipeline` waits for Phase 3 (no pipeline Lambda reads it yet); create `pipeline_app` the same way as the others then.

Database: `kentcrosswise` on the project's default branch.

**Direct or pooled.** Neon shows two hostnames; the pooled one contains `-pooler` and goes through PgBouncer in transaction mode.
- Migrations use the **direct** host. The runner holds a session-level `pg_advisory_lock` across several transactions; through a transaction-mode pooler the unlock can land on a different server session. Neon also recommends direct connections for schema migrations.
- Lambdas use the **pooled** host. Every warm Lambda instance keeps its own connection (web: a pool of 1 per role; relay: one per delivery; orchestrator: a `pg` pool), so concurrent instances could exhaust the compute's `max_connections` on direct connections. They keep no session state between transactions (the web app uses `SET LOCAL ROLE` inside each transaction), so transaction pooling is safe.

**URL format.** `postgresql://<user>:<password>@<host>/kentcrosswise?sslmode=verify-full`. Neon's Connect dialog shows `sslmode=require&channel_binding=require`. node-postgres treats `require` as `verify-full` anyway but logs a security warning, and it ignores `channel_binding` in the URL. Write `sslmode=verify-full` and drop `channel_binding`.

## 0. Before you start

- Neon console → project `kentcrosswise` → Settings: note the **Postgres version**. Steps below assume 16 or later (the default for new projects). If it is 15 or lower, stop and tell the Liaison: role grants work differently there.
- AWS console signed in with your admin identity, region **us-east-1**, Secrets Manager open.

## 1. Migrator login and database (Neon console)

1. **Postgres database → Roles → Add role** `migrator_app` → Create. Neon shows its password once. You do not need to copy it now: the Connect dialog in step 2 builds the connection string. If it is lost later, use **Reset password** on the role and update the secret.
2. **Postgres database → Databases → Add database** `kentcrosswise`, owner **`migrator_app`** → Create.

Why this is enough, and why both are needed:
- A role created in the console is a member of `neon_superuser`, which gives it `CREATEROLE`: migration 0001 creates the five group roles. On Postgres 16+, the role that creates a role gets `ADMIN` on it, so `migrator_app` can later grant those group roles to the login users (step 3).
- As owner of `kentcrosswise`, `migrator_app` has `CREATE` on the database (0002 runs `CREATE SCHEMA lg` for the LangGraph checkpointer) and owns its `public` schema (Postgres 15+ gives `CREATE` on `public` only to the database owner; 0001 creates tables there and grants `USAGE` on it).
- It owns every table, the view and schema `lg`, so it can grant on them. `v_public_agent_events` runs with its owner's rights, which is what lets `web_public` read it without table grants.
- Do not grant it anything else, and do not use the project's default `neondb_owner` / `neondb` for the app.

This model was rehearsed on PGlite (Postgres 18) with a non-superuser that has only `CREATEROLE` and owns the database: migrations 0001-0003 applied, and the SQL of step 3 and the checks of step 3.4 gave the expected results. It has not been run on Neon yet.

## 2. Fill `kcw/prod/migrator` and run the migrations

1. Neon → project dashboard → **Connect**: database `kentcrosswise`, role `migrator_app`, **Connection pooling off**. Copy the connection string. The host must **not** contain `-pooler`.
2. Secrets Manager → `kcw/prod/migrator` → **Retrieve secret value** → **Edit** (or **Set secret value** if it has none) → **Key/value**: key `db_url`, value = the string, with `sslmode=require&channel_binding=require` replaced by `sslmode=verify-full` → **Save**.
3. Tell the Liaison "migrator secret filled". The Liaison merges the PR `kcw/prod-db-strict-migrate` (it removes `--skip-if-unset` from `deploy.yml`), which runs `deploy.yml` on main. The **Migrate prod** step must apply `0001_hub_essays`, `0002_agent_system` and `0003_orchestrator_inbox`.

   Do it in this order: once that PR is merged, a missing or wrong `kcw/prod/migrator` fails every deploy at **Migrate prod**.
4. Neon → **SQL Editor**, branch = default, database **`kentcrosswise`**. Run:

   ```sql
   SELECT current_user;
   SELECT version, name FROM schema_migrations ORDER BY version;
   SELECT rolname FROM pg_roles
   WHERE rolname IN ('web_rw', 'web_public', 'orch_rw', 'pipeline_rw', 'migrator') ORDER BY 1;
   ```

   Expected: `migrator_app` (the editor connects as the database owner; **if it shows any other role, stop and tell the Liaison**: step 3 then needs a different client), 3 migrations, 5 roles.

## 3. Login users, grants and secrets

### 3.1 Where the passwords come from

The script below makes one random password per user on your machine (24 random bytes, base64 with `+` → `-` and `/` → `_`: 32 characters, about 190 bits, URL-safe, well above Neon's 60-bit minimum). It never prints them. It puts text on your clipboard one piece at a time and waits for Enter:

1. the SQL that creates the four users and grants their group roles (below, 3.2): paste it into the SQL Editor;
2. then each connection string in turn: paste it into its secret key.

Neon requires plain-text passwords in `CREATE ROLE` (hashed passwords are not supported), so they appear in the SQL Editor's **History** for this project. Delete those history items if the console offers it; anyone who can open the project's SQL Editor could reset the passwords anyway. If Windows clipboard history (Win+V) is on, clear it afterwards (Settings → System → Clipboard → Clear).

Get the pooled host first: Neon **Connect**, database `kentcrosswise`, **Connection pooling on**; copy only the host part, `ep-…-pooler.us-east-1.aws.neon.tech` (not secret).

```powershell
$poolHost = Read-Host "Pooled host (ep-...-pooler.us-east-1.aws.neon.tech)"
$users = [ordered]@{
  web_app        = @{ role = "web_rw";     secret = "kcw/prod/web";          key = "db_url" }
  web_public_app = @{ role = "web_public"; secret = "kcw/prod/web";          key = "db_url_public" }
  orch_app       = @{ role = "orch_rw";    secret = "kcw/prod/orchestrator"; key = "db_url" }
  relay_app      = @{ role = "orch_rw";    secret = "kcw/prod/relay";        key = "db_url" }  # interim, see 3.3
}
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$sql = foreach ($u in $users.Keys) {
  $bytes = New-Object byte[] 24
  $rng.GetBytes($bytes)
  $users[$u].pw = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_')
  "CREATE ROLE $u LOGIN PASSWORD '$($users[$u].pw)';"
  "GRANT $($users[$u].role) TO $u;"
}
$sql += "GRANT CONNECT ON DATABASE kentcrosswise TO $($users.Keys -join ', ');"
Set-Clipboard -Value ($sql -join "`n")
Read-Host "SQL copied. Paste it into the SQL Editor (database kentcrosswise), Run, then press Enter" | Out-Null
foreach ($u in $users.Keys) {
  $url = "postgresql://${u}:$($users[$u].pw)@$poolHost/kentcrosswise?sslmode=verify-full"
  Set-Clipboard -Value $url
  Read-Host "URL for $u copied. Secret $($users[$u].secret), key $($users[$u].key): paste, Save, then press Enter" | Out-Null
}
Set-Clipboard -Value " "
Remove-Variable users, sql, rng, bytes, url
```

For each URL: Secrets Manager → the secret → **Retrieve secret value** → **Edit** → **Key/value** → **Add row** with the key (or **Set secret value** if the secret is still empty) → **Save**. `kcw/prod/web` and `kcw/prod/orchestrator` already hold other keys (auth, Google, GitHub App): **add** the rows, do not replace the secret.

If the SQL fails part-way (for example a typo in the database name), nothing was saved to Secrets Manager yet: drop whatever was created (`DROP ROLE IF EXISTS web_app, web_public_app, orch_app, relay_app;`) and run the script again.

### 3.2 The SQL it produces

For review; the script fills in the passwords. Run as `migrator_app` in database `kentcrosswise`:

```sql
CREATE ROLE web_app LOGIN PASSWORD '<generated>';
GRANT web_rw TO web_app;
CREATE ROLE web_public_app LOGIN PASSWORD '<generated>';
GRANT web_public TO web_public_app;
CREATE ROLE orch_app LOGIN PASSWORD '<generated>';
GRANT orch_rw TO orch_app;
CREATE ROLE relay_app LOGIN PASSWORD '<generated>';
GRANT orch_rw TO relay_app;
GRANT CONNECT ON DATABASE kentcrosswise TO web_app, web_public_app, orch_app, relay_app;
```

- Roles made with SQL are not members of `neon_superuser` (roles made in the console are), so these users get only what is granted here. Do not create them in the console.
- A plain `GRANT` gives `INHERIT` and `SET`. The orchestrator and the relay use the group role's rights directly (`INHERIT`); the web app switches with `SET LOCAL ROLE web_rw` / `web_public` (`SET`).
- `web_app` and `web_public_app` are separate users so the public API's URL cannot reach owner data even if `SET LOCAL ROLE` were skipped.

### 3.3 The relay's role (finding)

The relay (`agents/webhook-relay/src/store.ts`) runs exactly:
- `INSERT INTO inbound_events (delivery_id, source) … ON CONFLICT (delivery_id) DO NOTHING RETURNING delivery_id` (dedupe claim),
- `DELETE FROM inbound_events WHERE delivery_id = $1` (release after a failed enqueue),
- `SELECT id FROM tasks WHERE pr_number = $1 …` and `… WHERE github_issue = $1 …` (task lookup).

That needs `INSERT`, `DELETE` and `SELECT (delivery_id)` on `inbound_events` (`RETURNING` and the `WHERE` need the column's `SELECT`; `INSERT` alone is refused), and `SELECT (id, pr_number, github_issue)` on `tasks`.

**No group role from 0001-0003 fits exactly.** `pipeline_rw` and `web_public` lack these grants. `web_rw` and `orch_rw` include them but give much more: `web_rw` reaches every owner table (diary, contacts, …); `orch_rw` can write every agent table (tasks, approvals, `system_flags`, so it could unpause agents), the `lg` checkpoints, contact names and inbox inserts. The runbook uses **`orch_rw` for now**, the narrower of the two, so the relay works from day one; its separate secret still keeps the orchestrator's App key away from it (DESIGN §11 Q8).

**Proposed follow-up (needs owner approval; not written yet):** a new migration with the next free number:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'relay_rw') THEN
    CREATE ROLE relay_rw NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO relay_rw;
GRANT SELECT (delivery_id), INSERT, DELETE ON inbound_events TO relay_rw;
GRANT SELECT (id, pr_number, github_issue) ON tasks TO relay_rw;
```

This exact grant set was checked on PGlite: all four relay statements succeed and `tasks.owner_text` and `agent_events` are refused. Once it is deployed, swap the membership in the SQL Editor: `GRANT relay_rw TO relay_app; REVOKE orch_rw FROM relay_app;`. DESIGN §3.4 would then list `relay_rw`.

If you would rather not give the relay `orch_rw` even for a while: in the script, drop `relay_app` from `$users` and create it after the migration. Until then, deliveries that need the database get `error (db)` (HTTP 500) and GitHub marks them failed; they can be redelivered later.

### 3.4 Check (SQL Editor, database `kentcrosswise`)

```sql
SELECT m.rolname AS login_user, r.rolname AS group_role, a.inherit_option, a.set_option
FROM pg_auth_members a
JOIN pg_roles m ON m.oid = a.member
JOIN pg_roles r ON r.oid = a.roleid
WHERE m.rolname IN ('web_app', 'web_public_app', 'orch_app', 'relay_app')
ORDER BY 1, 2;
```

Expected 4 rows, all `true`/`true`: `orch_app`→`orch_rw`, `relay_app`→`orch_rw`, `web_app`→`web_rw`, `web_public_app`→`web_public`.

```sql
SELECT
  has_table_privilege('web_public_app', 'v_public_agent_events', 'SELECT') AS public_view,       -- true
  has_table_privilege('web_public_app', 'tasks', 'SELECT')                 AS public_tasks,      -- false
  has_table_privilege('web_app', 'diary_entries', 'SELECT')                AS web_diary,         -- true
  has_table_privilege('orch_app', 'diary_entries', 'SELECT')               AS orch_diary,        -- false
  has_column_privilege('orch_app', 'contacts', 'name', 'SELECT')           AS orch_contact_name, -- true
  has_schema_privilege('orch_app', 'lg', 'CREATE')                         AS orch_lg,           -- true
  has_table_privilege('relay_app', 'inbound_events', 'INSERT')             AS relay_dedupe,      -- true
  has_column_privilege('relay_app', 'tasks', 'pr_number', 'SELECT')        AS relay_task_lookup, -- true
  pg_has_role('web_app', 'neon_superuser', 'MEMBER')                       AS web_is_admin;      -- false
```

Then tell the Liaison "prod DB secrets filled".

## 4. What you end up with

| Secret | Key | Value |
|---|---|---|
| `kcw/prod/migrator` | `db_url` | `migrator_app`, direct host |
| `kcw/prod/web` | `db_url` | `web_app`, pooled host |
| `kcw/prod/web` | `db_url_public` | `web_public_app`, pooled host |
| `kcw/prod/orchestrator` | `db_url` | `orch_app`, pooled host |
| `kcw/prod/relay` | `db_url` | `relay_app`, pooled host |
| `kcw/prod/pipeline` | `db_url` | Phase 3 |

All URLs end in `/kentcrosswise?sslmode=verify-full`.

## 5. Verification (the Liaison runs these)

Prod URL: `terraform -chdir=infra/prod output -raw url` (currently `https://d36w61sfnlrpvc.cloudfront.net`). In Git Bash set `MSYS_NO_PATHCONV=1` first.

1. **Migrations:** the `deploy.yml` run after the strict-migrate merge is green and its **Migrate prod** log lists 0001-0003 as applied (later runs: nothing pending). Step 2.4 and 3.4 queries match.
2. **Public feed:** `curl -s <url>/api/public/agent-events` returns `"available":true` (events may be empty).
   - `"available":false` with "The agent feed is not connected yet." → the web Lambda does not see the key. A warm instance keeps the `kcw/prod/web` value it read before the keys were added; re-run `deploy.yml` (a new build replaces the code, so new instances read the secret) and retry.
   - "The agent feed is unavailable right now." → a database error: the web Lambda log has one line with the error class and SQLSTATE (`28P01` wrong password, `42501` missing grant, `3D000` wrong database name).
3. **Owner pages:** signed in, `/console` and `/inbox` load without "The database is not connected yet." (the console shows the pause switches from `system_flags`).
4. **Orchestrator:** after its next SQS message, log group `/aws/lambda/kcw-prod-orchestrator` has no `init failed (…)` line (`SecretNotFoundError`, `SecretKeyMissingError`, `CheckpointSchemaMissingError`, or a `pg` error class). `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'lg';` then lists the checkpointer tables, owned by `orch_app`.
5. **Relay** (log group `/aws/lambda/kcw-prod-relay`, one `relay: <result> … delivery=<id>` line per delivery):
   - Database reachable: a `pull_request` event from an allowed sender on a PR that has no task logs `ignored (no_task)`, not `error (db)` (the lookup by PR number ran).
   - Dedupe: on a delivery that logged `forwarded`, GitHub → orchestrator App settings → **Advanced** → Recent Deliveries → **Redeliver**. The redelivery keeps the same delivery id and must log `duplicate`; `SELECT count(*) FROM inbound_events WHERE delivery_id = '<id>';` returns 1.

## 6. Rollback

- **Before the strict-migrate PR is merged:** delete the `db_url` key from `kcw/prod/migrator`. `deploy.yml` logs "Migrations skipped" again and continues.
- **After it is merged:** revert that PR first (it touches `.github/**`, a critical path), or every deploy fails at **Migrate prod** while the secret is missing or broken.
- **Cut one runtime off (reversible):** SQL Editor, `ALTER ROLE web_app NOLOGIN;` (back with `LOGIN`). Or delete its secret key: the web app then shows "not connected yet" (after a cold start), the orchestrator returns its messages to the queue (DLQ after the retry limit), the relay answers 500 for deliveries that need the database.
- **Rotate a password:** generate one as in 3.1, then `ALTER ROLE <user> PASSWORD '<new>';` in the SQL Editor and update its secret key. Old connections keep working until they reconnect.
- **Schema mistakes:** fix forward with a new migration. Applied migrations are never edited (the runner refuses changed checksums).
- **Full reset (only while prod holds no real data; not rehearsed):**
  1. Neon → Databases → delete `kentcrosswise` (drops all tables, schema `lg` with its checkpoints, and `schema_migrations`).
  2. Add database `kentcrosswise` again, owner `migrator_app`; open the SQL Editor on it and run
     `DROP ROLE IF EXISTS web_app, web_public_app, orch_app, relay_app, web_rw, web_public, orch_rw, pipeline_rw, migrator;`
  3. Re-run `deploy.yml` (migrations recreate everything), then step 3 again with new passwords (the old URLs no longer work).
