# Map `workflow_run.requested` to tasks by run ID

Status: owner-approved 2026-10-28; implemented locally on `docs/run-id-mapping-spec-20261028`, not yet published. Fixes the missing trusted `starting` state seen on task 3.

## Problem

The relay links an agent workflow run to its task through the run title `developer task N` (`agents/webhook-relay/src/normalize.ts`). GitHub sends `workflow_run.requested` before it evaluates `run-name`. The task 3 delivery `60c99360-d217-11f1-9b86-3796395aa21c` (run 40526955264, attempt 1) arrived 2 s after dispatch with `display_title` and `name` set to `agent-developer`. Every other field passed the guards: path, `workflow_dispatch`, `main`, same repository and allowed sender. The relay answered `202 ignored (no_task)`, so `agent_runs.requested_at` stayed NULL and the office never showed `starting`. The later `completed` delivery carried the evaluated title and mapped correctly.

The orchestrator dispatches with `createWorkflowDispatch` and discards the response. It never learns the run ID.

## GitHub API facts (checked 2026-10-28)

- [Breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes), version `2026-03-10`: the dispatch response changes "from `204` to `200` with workflow run details", and the version removes the `return_run_details` parameter.
- Version `2022-11-28` (the default for unversioned requests; supported until 2028-03-10 per [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)) accepts `return_run_details: boolean`. With `true` it returns 200 and `{ workflow_run_id: int64, run_url, html_url }`; with `false` or omitted it returns 204. Source: `@octokit/openapi-types@29.0.1` `actions/create-workflow-dispatch`.
- The orchestrator's `@octokit/rest@22.0.1` resolves to `@octokit/openapi-types@27.0.0`, which does not type `return_run_details`.

## Design

### 1. Dispatch returns the run ID

`GitHubPort.dispatchWorkflow` returns `{ runId: number | null }`.

- Call `octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", …)` with `return_run_details: true` and an explicit `X-GitHub-Api-Version: 2022-11-28` header. Using `request` avoids a dependency upgrade; upgrading `@octokit/rest` would need owner approval.
- On 200, validate `workflow_run_id` as a positive safe integer. Parse the run ID from the raw response text, or check `Number.isSafeInteger`. Current IDs are around 4×10¹⁰, but GitHub delivery IDs already exceed 2⁵³; refuse rather than round.
- On 204, a missing field or an invalid value, return `{ runId: null }` and log a fixed code (`dispatch_run_id_missing`). Never fail or retry the dispatch because run details are missing; the run was created. Behaviour then falls back to today's title hint.
- Accept both response shapes, so a later move to API version `2026-03-10` only drops the parameter.
- The fake GitHub port returns deterministic run IDs, plus a mode that returns null.

### 2. Store the dispatch link

Migration `0010_agent_dispatches.sql` (one-way, additive, with `SET LOCAL lock_timeout = '5s'` like 0007):

```sql
CREATE TABLE agent_dispatches (
  run_id bigint PRIMARY KEY CHECK (run_id > 0),
  task_id bigint NOT NULL REFERENCES tasks(id),
  role text NOT NULL CHECK (role IN ('developer','qa','docs','scraper')),
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON agent_dispatches TO orch_rw;
GRANT SELECT (run_id, task_id, role) ON agent_dispatches TO relay_rw;
```

- Keep it a separate table, not an early `agent_runs` row. `agent_runs` has office version and outbox triggers, and a row there means a signed webhook observation. A dispatch link is not one.
- The orchestrator inserts the link immediately after a successful dispatch with a non-null run ID. Use `ON CONFLICT (run_id) DO NOTHING`, then read back the row; `recordDispatch` reports a conflicting `task_id` or `role` with the fixed code `dispatch_link_conflict`. The link is advisory (the title fallback still maps the run), so when storing it fails after a successful dispatch (a conflict or a database error), the machine logs `dispatch_link_failed role=<role> reason=<conflict|db>` and continues with the event and phase change. The step does not fail, so the message is not retried and the run is not dispatched again.
- Insert before `event(...)` and `enter(...)` in `dispatchDev`, `dispatchDocs` and `dispatchQa` (`agents/orchestrator/src/graph/machine.ts`).
- Map the role from the workflow file: `agent-developer.yml` → developer, `agent-qa.yml` → qa, `agent-docs.yml` → docs, `agent-scraper.yml` → scraper. The sweeper dispatches only `preview-gc.yml`, never an agent workflow, so it records no links. Agent re-dispatches after timeouts go through the machine's `dispatch*` methods.
- No pruning in this change. The table grows by one row per agent run.

### 3. Relay maps by run ID

In `normalize.ts`, for `workflow_run` with action `requested` or `completed`, compute the existing guard set unchanged: role from the exact path regex, `event === "workflow_dispatch"`, `head_branch === "main"` and same repository.

- **Title matches:** keep today's `agent_task_id`. Also expose `agent_run: { run_id, role }` so the relay can cross-check.
- **Guards pass but the title doesn't match** (the `requested` case): set `agent_run: { run_id, role }` and no `agent_task_id`.
- **Guards fail:** unchanged. Never map by path alone.

In `relay.ts`, before the PR, issue and branch lookups:

1. If `agent_run` is present, look up `agent_dispatches` by `run_id` (new `store.findDispatch(runId)`).
2. **Row found:** the row's `role` must equal the path role. On mismatch, return `202 ignored (dispatch_mismatch)`. If a title-derived `agent_task_id` is also present and differs from the row's `task_id`, return `202 ignored (dispatch_mismatch)`. Otherwise `taskId = row.task_id`.
3. **No row, but a title-derived `agent_task_id` exists:** use it, as today.
4. **No row and no title:** retry the lookup up to 3 times about 1 s apart, staying well inside GitHub's 10 s delivery timeout and the relay Lambda timeout. Then return `503 error (dispatch_pending)` without claiming the delivery.
   - The sweeper (every 15 min) already redelivers 5xx deliveries: 180 min lookback, at most 4 attempts.
   - A dispatch whose run ID came back null never gets a row. Its `requested` exhausts the redeliveries and is then lost, which is the same outcome as today. Count it through the fixed log code.
   - Every agent run the orchestrator never linked ends on this path whenever its delivery carries no evaluated task title (typically `requested`; also `completed` if the title never matches): Scraper runs, manual owner dispatches, and dispatches whose run ID came back null (or whose link failed, `dispatch_link_failed`). The relay logs them with fixed fields only: `relay: error (dispatch_pending) event=workflow_run delivery=<id> role=<role> action=<requested|completed>`. Grep for `dispatch_pending` and group by `role`/`action`; the same delivery repeating up to the redelivery limit is a never-mapped run, not an outage.
5. The forwarded message carries the resolved `task_id`. The orchestrator's `recordRun` stays unchanged and sets `requested_at`.

Sender allowlist, signature, repository, path and branch checks stay exactly as they are. Recording Actions minutes for `completed` is unchanged.

### 4. Orchestrator

No state machine change: `requested` already flows to `recordRun` when a task ID is present. Make sure a `requested` that arrives after `completed` (a redelivery) does not regress state. The existing upsert only sets `completed_at` on conflict and never clears it; add a test for this.

## Tests (must fail before the fix)

- **Normalize/relay:** a real-shaped `requested` payload with `display_title` `agent-developer` and a stored dispatch row is forwarded to that task. The same payload without a row gets 3 lookups, then 503 with no claim. Also cover: role mismatch returns `dispatch_mismatch`; a title-derived task ID that conflicts with the row returns `dispatch_mismatch`; failed guards (wrong path, `push` event, another branch or repository) are never looked up.
- **Octokit adapter:**
  - The request sends `return_run_details: true` and the version header.
  - A 200 response returns the run ID.
  - A 204 response returns null without throwing.
  - A run ID above 2⁵³ is refused.
- **Machine:** each `dispatch*` inserts its link before the task event, and a null run ID inserts nothing.
- **DB:** test 0010 grants as a non-superuser. `relay_rw` can SELECT only the three columns and cannot INSERT. `orch_rw` can SELECT and INSERT but cannot UPDATE.
- **Replay fixture:** the selected task 3 delivery fields recorded above, kept as a regression fixture without the full payload.

## Rollout and verification

1. PR with exact-head CI and an independent review, then the owner merge procedure. Migration 0010 runs on deploy while `agents_paused=true`, with no console session open.
2. No backfill. Task 3 keeps `requested_at` NULL, and no observation is fabricated.
3. Acceptance: one owner-authorized controlled agent run. Check that the relay logs `forwarded … workflow_run.requested` for that run, `agent_runs.requested_at` is set, and the public office shows trusted `starting` before `completed`.
4. After deploy, watch the orchestrator logs for `dispatch_link_failed` (any occurrence means a run maps only by title or not at all) and the relay logs for repeated `dispatch_pending` on Developer, QA or Docs runs.
5. Later, moving to API version `2026-03-10` means removing `return_run_details` and keeping the header in step. Parsing already accepts both shapes.

## Out of scope

- Mapping by path or time window.
- Weakening the sender, repository or path guards.
- Using `in_progress` as the start signal.
- Changes to PR #51's content. PR #51 stays held until this fix ships and the acceptance run passes.
