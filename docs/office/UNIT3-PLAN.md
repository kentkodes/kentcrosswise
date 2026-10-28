# Unit 3 plan: outbox, projector and trusted execution observations

Owner accepted all three defaults on 2026-10-26: Q1 `starting` from a requested trusted workflow (local 0006/parser change); Q2 the three local workflow `run-name` additions; Q3 poison rows immediately dead for `P0K01`, otherwise backoff and dead after eight failures. These decisions authorize the local implementation and local race tests. They do not authorize publication, deployment, live database changes or workflow enablement. Local implementation, independent QA and isolated packaging validation are complete; the numbered questions below record the accepted proposals. No rollout occurred.

Status: architect plan, 2026-10-26, local only. Built on unit 2 ([LIVE-CONTRACT.md](LIVE-CONTRACT.md#local-projection-unit), [0006](../../packages/db/migrations/0006_office_projection.sql)). Owner decisions for unit 3 are in [HANDOFF.md](../HANDOFF.md) ("Owner decisions 2026-10-26") and are not reopened here. Grants, triggers on existing tables, orchestrator/relay changes and any `.github/**` edit are security-critical and need the existing critical review before rollout; nothing here authorizes a live database, workflow or deployment change.

This plan replaces the contract's earlier "every writer takes the revision lock in its own transaction" proposal with the owner-selected outbox: source writes only enqueue; the projector alone calls `office_project()`.

## 1. Design in one paragraph

Database triggers on the projected source tables insert one tiny outbox row (table name, source key, source version; no content) in the same transaction as each relevant source write. A single SECURITY DEFINER function `office_drain(limit)` claims pending rows in id order under one advisory lock. For each row it reads the current committed source row, applies the version guard, builds an `office_project()` transition, and records the outcome on that row in a per-row savepoint. The projector runs as orch_rw after each orchestrator Lambda batch and each sweeper run, and as web_rw after console task/pause writes. It is always best-effort: callers catch and log failures, so they never change an SQS, sweep or console result. Trusted execution facts come from signed `workflow_run` webhooks. The relay maps them to a task, the orchestrator records them in a new `agent_runs` source table, and the trigger feeds that table through the same outbox.

Why triggers rather than explicit outbox inserts in each store method: they capture every writer, including raw SQL in `claimSlot`, the console, seeds and future pipeline_rw writers. They make the same-transaction guarantee structural, and they need no refactor of the existing non-atomic task/event statement pairs. Each statement is captured where it commits.

## 2. Source-write inventory

"Projected columns" for `tasks` are `status, waiting_on, agent, public_title, is_private, parent_id, source`. `source` also enqueues because it determines task kind. Other columns (`thread_id, branch, github_issue, pr_number, head_sha, attempts, updated_at`) do not enqueue. The version trigger compares the projected columns before enqueueing.

| Source (file:line) | Writes | Office transition | Kind | Source version |
|---|---|---|---|---|
| store.ts:150 `claimSlot` | tasks.status=planning | task snapshot (state planning) | state | tasks.office_version |
| store.ts:173 `updateTask` via machine.ts:227 `enter` | status, waiting_on, agent | task snapshot (state, waiting_on, role); unbinds execution if role changed | state | tasks.office_version |
| store.ts:173 via machine.ts:304 `plan` | public_title (+branch) | task snapshot; relabel/redact handled by office_project | state | tasks.office_version |
| store.ts:173 via machine.ts:272, 346, 402, 409, 424, 462, 665, 669 | branch, github_issue, pr_number, head_sha, attempts | none (non-projected columns) | none | none |
| store.ts:254 `createSubtasks` (INSERT) | child rows (parent_id, is_private) | task snapshot, parent_kind planner_parent, kind work | state | tasks.office_version (1 on insert) |
| store.ts:261, 289; console.ts:69 | thread_id | none | none | none |
| store.ts:283 `createDocsTask` (INSERT) | docs child (source github, parent_id, public_title, is_private) | task snapshot, kind docs, parent_kind docs_parent | state | tasks.office_version |
| console.ts:65 `createTask` (web_rw, INSERT) | console task | task snapshot (queued) | state | tasks.office_version |
| store.ts:177 `addEvent`. Emitters: machine.ts:244 (report), 367, 378, 387, 403, 411, 425, 449, 452, 483, 488, 504, 538, 572, 602, 650, 676 | agent_events row | one journal event, original `ts`, execution null; a report event may also annotate (section 6) | additive | none (dedupe by outbox id) |
| console.ts:150 `setFlag('agents_paused')` (web_rw) | system_flags | pause {paused, observed_at=updated_at} | state | system_flags.office_version |
| console.ts:150 `setFlag('pipelines_paused')` | system_flags | none (trigger `WHEN key = 'agents_paused'`) | none | none |
| New: orchestrator `recordRun` (section 6) | agent_runs upsert | execution create/observe, task binding | state | agent_runs.office_version; binding uses (run_id, run_attempt) |
| store.ts:190, 195 `addUsage`; relay store.ts:55 minutes | usage_events | none: usage only annotates and is not projected | none | none |
| store.ts:209, 214, 238; console.ts:222, 228 | approvals, inbox_items | none: waiting_on_owner already arrives through events and status | none | none |
| relay store.ts:42, 48 | inbound_events | none | none | none |
| seeds/agents.ts:117, 128; future pipeline_rw INSERTs (0002:146) | tasks, agent_events | same as above (the triggers fire for every role) | as above | as above |
| DELETE on tasks / ON DELETE CASCADE | row removal | none in unit 3 (tombstones are a later unit, section 10) | none | none |

The kind mapping is `docs` when `source = 'github' AND parent_id IS NOT NULL`. This is the console's existing `IS_DOCS_TASK`, and it holds by construction: only `createDocsTask` writes `source = 'github'`, and docs tasks never split. Add a test that pins this. The drain maps `waiting_on` to `CASE WHEN status = 'waiting' THEN waiting_on END`, so a stale waiting_on on a non-waiting row cannot poison the row through office CHECKs.

## 3. Schema: append-only migration 0007

Use 0007, not an edit of 0006. Unit 2 was reviewed and QA'd as one unit, and 0007 touches existing tables (columns and triggers on `tasks` and `system_flags`), which is a separate risk class for critical review. Local scratch databases also already hold the 0006 checksum. The one exception is Q1 (section 9): a CHECK relaxation is better done by editing 0006, which has never been applied anywhere live, than by `DROP CONSTRAINT` in 0007, which would be owner-critical.

- **Version columns:** `tasks.office_version`, `system_flags.office_version` and `agent_runs.office_version`, each `bigint NOT NULL DEFAULT 1`. A BEFORE INSERT OR UPDATE trigger always overwrites the column: 1 on insert, `OLD + 1` when projected columns change, `OLD` otherwise. Writers cannot set it, even though they hold table-level UPDATE.
- **`office_outbox`:**
  - `id bigint GENERATED ALWAYS AS IDENTITY PK`
  - `source_table text NOT NULL`, `source_key text NOT NULL`, `source_version bigint`
  - `enqueued_at timestamptz DEFAULT now()`
  - `status text DEFAULT 'pending'`, one of pending, projected, superseded, skipped, dead
  - `attempts int DEFAULT 0`, `next_attempt_at timestamptz DEFAULT now()`, `last_error text`, `handled_at`, `revision bigint`
  - Partial index `(id) WHERE status = 'pending'`.
  - No foreign keys, uniqueness constraints or content. This keeps the insert trivially safe and means no private text is stored. Triggers on `office_outbox` forbid DELETE and TRUNCATE and forbid UPDATE of the source columns.
- **Enqueue triggers:** AFTER INSERT OR UPDATE on `tasks` (projected columns), `agent_events` (INSERT), `system_flags` (agents_paused) and `agent_runs`. One SECURITY DEFINER function with `search_path` pinned to `pg_catalog, pg_temp` and schema-qualified names. It does only an `INSERT ... VALUES (TG_TABLE_NAME, key, NEW.office_version)`. Firing a trigger needs no EXECUTE privilege from the writer.
- **`agent_runs` (new source table):**
  - Key and binding: `run_id bigint`, `run_attempt int`, PK `(run_id, run_attempt)`, `task_id bigint NOT NULL` (no foreign key, so a missing task cannot fail the orchestrator), `role text CHECK IN (developer, qa, docs, scraper)`.
  - Observations: `requested_at timestamptz`, `completed_at timestamptz`, `conclusion text`, plus `office_version`.
  - The run id and attempt never leave the server; office_refs maps them to a random reference.
- **`office_source_versions(entity text PK, version numeric NOT NULL)`:** the guard store, private.
- **`office_drain(p_limit int) RETURNS jsonb`:** SECURITY DEFINER, same owner as `office_project`. It returns counts only (projected, superseded, skipped, retried, dead, remaining, busy).

**Grants:**

| Role | Gets |
|---|---|
| orch_rw | `SELECT, INSERT, UPDATE` on agent_runs (ON CONFLICT needs SELECT on the arbiter); EXECUTE on office_drain |
| web_rw | EXECUTE on office_drain |
| office_project | Remains granted to no role; only the definer-owned drain calls it, so writers can never forge transitions |
| relay_rw, pipeline_rw, web_public | Nothing new |

No role gets any privilege on office_outbox or office_source_versions. Extend the existing grants guard test with these exact lists.

**Claim and lock:**
1. `pg_try_advisory_xact_lock(<office constant>)`. If the lock is busy, return `{busy: true}` at once; never wait.
2. `SELECT ... WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY id LIMIT p_limit FOR UPDATE`.
3. Process each row in a plpgsql `BEGIN ... EXCEPTION` block (a savepoint), then update the row's status in the same transaction.

Use a single drainer rather than `FOR UPDATE SKIP LOCKED`. `office_project` already serializes on the state-row lock, so parallel projectors gain nothing, and SKIP LOCKED would let two projectors journal one task's consecutive events in swapped order. Consequence: a late-committing lower id is projected in a later drain, so journal order is projection order, not source order. Events keep their original `recorded_at`, and nothing is skipped (no high-water mark).

**Poison rows:**
- P0K01: `dead` at once. It is a bug, not a retry case.
- Any other caught error: `attempts + 1`, `next_attempt_at = now() + least(30 s × 2^attempts, 1 h)`, using the prior failure count, then `dead` after 8 attempts. Actual elapsed time also depends on drain frequency.
- `last_error` holds the SQLSTATE, plus the message only when it starts with `office_project:` (those messages are fixed text).
- Eligible rows are ordered by id among those whose backoff has expired, so a failing row never blocks later rows.
- `dead` rows are kept and counted in every drain result. The sweeper logs `office dead=N` each run. Re-drive is an owner/migrator SQL statement (pending, attempts 0), to be added to the prod-db runbook later.
- Uncatchable errors (statement timeout, lost connection) roll back the whole batch and leave every row pending. Per-row work is bounded (one source row and a bounded transition), and callers use batches of 50 with `statement_timeout` of 5 s. See risk R3.

**Skipped, with an explicit recorded reason (never silent):** source row gone, `deployed` or `router` events while those capabilities are off, an event or run for a task id ≤ 0.

**Retention:** keep every outbox row in unit 3. Rows hold ids only, which matches the contract's no-automatic-deletion rule. Pruning handled rows is an open point.

**Initial state:** 0007 enqueues one row for `agents_paused`, so the first drain projects the current pause. That is current state, not history. Pre-0006 history is not backfilled. Active pre-0007 tasks appear on their next projected write, which every in-flight task gets at its next step. A parent or task that is not yet projected is created as a bare private row (next paragraph).

**Dependency safety:** every transition built by the drain lists bare `{task_id}` entries for each referenced task and parent before using them. Pass 1 of office_project then creates the reference, defaulting to private ("Private task"). An event, run or child that commits before its task's snapshot, or that belongs to a pre-0006 task, therefore never fails on "not projected".

## 4. Projector placement, trigger and lag

No new infrastructure, Terraform or IAM change. All three callers already exist with the right database role.

| Caller | Role | When | Behavior |
|---|---|---|---|
| Orchestrator Lambda ([lambda.ts](../../agents/orchestrator/src/lambda.ts)) | orch_rw (existing pool) | After `handleTaskSqsEvent` returns, every batch | Up to 3 drain calls while a call returns a full batch. try/catch, logs the error class and SQLSTATE only, and never alters `batchItemFailures` |
| Sweeper Lambda ([sweeper/lambda.ts](../../agents/orchestrator/src/sweeper/lambda.ts)) | orch_rw | Every 15 min (existing EventBridge schedule) | Same loop. A failure is logged, **not** added to `report.failed`, because that would throw and trigger async retries of the whole sweep |
| Console actions ([actions.ts](../../apps/web/src/app/(owner)/console/actions.ts)) | web_rw (`withDb`) | After `createTask` and `setFlag` commit, as a separate `withDb` call | Best effort; the action result is unchanged |

Lag bound: seconds in normal operation, since every relay event, report and sweep goes through an orchestrator invocation that drains afterwards. A pause toggle projects immediately through the console. The worst case is 15 minutes (the next sweep) plus backoff for a failing row. "Busy" callers do not wait: the active drainer or the next trigger picks up their rows.

## 5. Version guard

- **The version is a per-row monotonic counter set by the BEFORE trigger under the source row's lock.** It cannot tie or go backwards. `tasks.updated_at` was rejected for two reasons: `now()` is transaction-start time, so an earlier-starting transaction can commit later with a smaller value, and several writers (thread_id, branch) do not maintain it.
- **The drain reads the current committed source row, not a payload snapshot.** If its version is ≤ `office_source_versions[entity]`, the row is marked `superseded` with no revision. Otherwise the drain projects it and stores the version. Entities are `task:<id>`, `flag:agents_paused`, `run:<id>:<attempt>` and `bind:<task_id>` (section 6).
- **Effects:** a delayed or retried older row can never overwrite newer state. Several queued rows for one task collapse to one revision. Privacy uses the current title (the safest view). Events stay additive and are never guarded.

## 6. Execution observations from `workflow_run`

**Relay ([normalize.ts](../../agents/webhook-relay/src/normalize.ts), [relay.ts](../../agents/webhook-relay/src/relay.ts)).** Today an agent run is dispatched on `main` with no PR, so the relay drops it as `no_task`. Add a derived hint, `agent_task_id`. It is set only when all of these hold:
- `workflow_path` is exactly `.github/workflows/agent-{developer,qa,docs,scraper}.yml`
- `trigger` is `workflow_dispatch` and `head_branch` is `main`
- `display_title` matches exactly `^(developer|qa|docs|scraper) task ([1-9]\d{0,15})$`, and its role word equals the path's role.

Never forward `display_title` itself (for PR-triggered workflows it is human text). The sender allowlist and signature check are unchanged. Docs already has `run-name: docs task <id>`; developer, QA and scraper need the same one-line `run-name` (Q2).

*Amended by [RUN-ID-MAPPING-SPEC](RUN-ID-MAPPING-SPEC.md):* GitHub sends `requested` before it evaluates `run-name`, so the title alone misses it. The same guards now also yield `agent_run {run_id, role}`; the relay maps by the orchestrator's `agent_dispatches` row first, keeps the title as cross-check and fallback, and answers `503 dispatch_pending` while the row is missing.

**Orchestrator:**
- [messages.ts](../../agents/orchestrator/src/graph/messages.ts) additionally parses `run_attempt`, `head_branch`, `run_started_at` and `updated_at`.
- In `Machine.run` ([machine.ts](../../agents/orchestrator/src/graph/machine.ts)), right after the report branch and **before the pause check**, an agent-workflow `workflow_run` goes to `observeRun()` and returns. Observations are recorded while paused, never drive the PR loop and never count as stale. CI runs are unaffected.
- `TaskStore.recordRun` upserts `agent_runs`:
  - `requested` runs `INSERT ... ON CONFLICT DO NOTHING`.
  - `completed` inserts or updates `completed_at` and `conclusion` only `WHERE conclusion IS NULL`, so source-side terminal immutability holds and a late `requested` changes nothing.
  - Times are clamped to `least(github_time, now())`, with now() when the value is null or before 2000. GitHub clock skew can then never trip office_project's "future" check.

**Drain mapping for an `agent_runs` row:**
- Execution key `run:<run_id>:<run_attempt>` (private source_key), with `task_id`, `role` and `station = role`.
- Developer seat: the lowest of 1–4 not held by an execution currently bound to an active task, otherwise the lowest free annex seat. It is assigned once at first binding and never changed.
- Phase:
  - Completed: `terminal` with `observation_source = trusted_workflow`, `observed_at = completed_at`.
  - Requested only: `unknown`, or `starting` from `trusted_workflow` if Q1 is accepted.
  - Capability `execution_observations` off: always `unknown` with no observation. Turning it on later does not rewrite already-handled rows; they stay unknown.
- Conclusion to outcome:

  | Conclusion | Outcome |
  |---|---|
  | success | succeeded |
  | cancelled, skipped, stale | cancelled |
  | failure, timed_out, startup_failure, action_required, neutral, null, unknown | failed |

  A pause-all cancellation by the sweeper therefore projects as terminal cancelled. Completion without any report or usage still projects as terminal.
- `running` stays unavailable: it needs `trusted_work_job`, which needs `workflow_job` events the App does not subscribe to. It remains unknown and is not invented.

**Binding (task's current execution).** Bind a run as the task's `execution` only if all of these hold:
- its `(run_id, run_attempt)` is greater than the stored `bind:<task_id>` version (numeric `run_id × 2147483648 + attempt`, with a positive PostgreSQL integer attempt, avoiding collisions above attempt 999)
- the task's current projected role equals the run's role (otherwise office_project's cross-row rule would reject it).

Otherwise the execution is recorded unbound. A task snapshot whose new role differs from the bound execution's role includes `execution: null`.

**Replacement and late reports:**
- A redispatch (new run id) or a re-run (new attempt) gets a new execution reference and moves the binding.
- An older run's late `requested` never rebinds. Its late `completed` makes that execution terminal (history) but does not touch the binding.
- Unit-2 terminal immutability is respected because the drain never sends a phase to a terminal execution.
- A report event (`agent_events.detail->>'source' = 'report'`, read by the definer at drain time; detail is never copied out) becomes a journal event with execution null. It also sets `reported_activity` and `reported_at` on the bound execution only when all of these hold:
  - the execution is non-terminal and has the same role
  - it is the only non-terminal execution of that task and role
  - `ts` is newer than the existing `reported_at`.

  Reports carry no run id, so this is the most that can be attributed safely. Ambiguous reports only add the event. Usage is never projected.

## 7. Implementation steps (one Developer each, in order)

1. **0007 part A: outbox, versions, triggers, agent_runs, grants (no drain).** Tests (PGlite):
   - Each inventory row enqueues exactly as listed; non-projected updates enqueue nothing.
   - Versions strictly increase, and a writer-supplied office_version is overwritten.
   - A rollback leaves no outbox row.
   - pipeline_rw and relay_rw writes still succeed and still enqueue.
   - Every role is denied on outbox and versions.
   - Existing db, orchestrator, relay and web suites stay green; the grants guard is extended.
   - A fresh migrate plus non-superuser migrator rehearsal passes.
2. **0007 part B: `office_drain` and the mapping, guard, binding, seat and poison logic.** Tests (PGlite):
   - The task, event, pause and run mappings, including docs and planner parents and bare pre-0006 parents.
   - Superseded older versions.
   - An event before its task snapshot.
   - A role change unbinds.
   - Capability off: unknown. Capability on: terminal.
   - `deployed`/router events skipped with a reason.
   - P0K01 goes straight to dead; backoff and dead-after-8 never block later rows; dead rows can be re-driven.
   - EXECUTE for orch_rw and web_rw only; office_project is still denied to everyone.
   - The counts JSON carries no content.
3. **(If Q1 is accepted) edit 0006 and the unit-1 parser** to allow `starting` with `trusted_workflow`, gated by `execution_observations`. Update the affected unit-1 and unit-2 tests.
4. **Relay mapping.** Tests: an exact match maps; a wrong path, trigger, branch, title or role mismatch does not; display_title never appears in the message or logs; actions-minutes behavior is unchanged.
5. **Orchestrator observations** (messages, `observeRun`, `recordRun`). Graph tests over pg-socket:
   - start; completion without usage; cancellation while paused; late `requested` after `completed`
   - timeout redispatch (replacement); owner re-run (attempt 2); report after completion
   - observations in ci/qa/merge phases are neither stale nor loop-driving; clock-skew clamp.
6. **Projector wiring** in the orchestrator Lambda, the sweeper and the console actions. Tests: an injected drain failure leaves SQS batch responses, sweep reports and console redirects unchanged; full-batch looping stops at 3 calls; logs contain only the class and SQLSTATE.
7. **End-to-end local check:** console task, then graph steps with FakeGitHub, then relay-shaped `workflow_run`, then drain. `v_office_*` and the unit-2 read adapter then show the task, binding, terminal outcome and pause, and the old five-field feed is unchanged.
8. **Real two-connection Postgres race tests** (pgserver venv; a Vitest file in `packages/db/test`, skipped unless `KCW_REAL_PG_URL` is set, so CI is unaffected and no dependency is added; the Liaison authorizes starting the server):
   - **(a) Out-of-order commit:** writer A holds an uncommitted task update (low outbox id) while B commits a higher id. A drain projects B. After A commits, the next drain projects A; both rows end `projected`.
   - **(b) Two projectors:** A calls the drain inside an open transaction; B's drain returns `busy` without blocking. After A commits, B drains the rest. Every row is handled exactly once and revisions are gap-free.
   - **(c) Writer and projector interleaving:** with A's drain transaction holding the projection state lock, B's source update, event insert and pause write commit under `lock_timeout = 1s`, so writers never wait on projection. The drain does not lock source rows.
   - **(d) Older state after newer:** a v2 row is forced into backoff, v3 projects, then v2 retries and ends `superseded`. Also: a run's `completed` before `requested`, and an older run's late `requested` after a newer binding.
   - **(e) Repeat (a) and (b) for 1000 random interleavings**, asserting gap-free `(revision, ordinal)` and no row left pending after a final drain.
9. **Enable `execution_observations` locally.** Use a documented local-only migrator statement (`office_project('capability:execution_observations', ...)`) after steps 1–8 pass. Deployed and router capabilities stay off; there is no migration or code path that enables it.
10. **Docs:** update LIVE-CONTRACT (the outbox replaces the per-writer revision lock; execution mapping; capability state), HANDOFF and OPEN-POINTS. QA reviews steps 1–9 independently before the Liaison reports.

## 8. Critical-scope notes

- **Owner-critical by repository rules (rule 10):** migration 0007 (grants, SECURITY DEFINER functions, triggers on `tasks`/`system_flags`), relay and orchestrator trust-path changes, and the Q2 workflow `run-name` edits (`.github/**`). Everything stays local and uncommitted until the owner's critical review.
- **No Terraform, IAM, secret, App permission or webhook subscription change is required.** Prod rollout later means only the normal deploy migration plus Lambda bundles, and deployed `execution_observations` stays off.

## 9. Owner questions (each changes what gets built)

- **Q1. May a requested `workflow_run` project as phase `starting` with source `trusted_workflow`?** This needs a CHECK edit in untracked 0006 and a unit-1 parser change. Without it, a run shows `unknown` until it completes. *Proposed default: yes, edit 0006 (never applied live) and gate it by `execution_observations`.*
- **Q2. Add `run-name: <role> task ${{ inputs.task_id }}` to agent-developer.yml, agent-qa.yml and agent-scraper.yml?** This is an owner-critical `.github/**` edit, local only. Without it, only Docs runs can be mapped to tasks; developer and QA executions stay unknown and unbound. *Proposed default: yes, as a separate reviewed local change with actionlint.*

## 10. Risks

- **R1. GitHub run ids are assumed to increase over time.** This is observed behavior, not documented. If it is violated, only the current-execution display is wrong; lifecycle and history are not affected.
- **R2. Privacy lag.** A public→private or retitle change reaches the office only when drained, worst case about 15 minutes. No UI changes privacy today; title changes come only from replanning.
- **R3. An uncatchable error on a single row** (statement timeout, crash) would keep rolling its whole batch back. Mitigation: bounded per-row work, a 5 s batch timeout, logged counts. A recurring batch failure needs the owner re-drive or dead-marking SQL. Watch the logs after the first deploy.
- **R4. Duplicate events.** A redelivered orchestrator step re-inserts agent_events (an accepted cost today), so the journal gets duplicate events, as the old feed does.
- **R5. Deletion is not projected.** A deleted public task's title remains in the projection until the tombstone unit; there is no delete writer today.
- **R6. Seeds and tests now enqueue outbox rows.** This is harmless, but preview databases will project seed data once a drain runs there.
- **R7. Ambiguous reports are not attributed.** Reports have no run id, so ambiguous ones only add events. Exact attribution would need a run id in report messages (workflow plus core change, out of scope).
