# Connected woodland office: design draft

Draft prepared 2026-10-25 America/Chicago. The owner confirmed the outcome and draft workflow; this is a reviewable proposal for the next extension, not an approved final production specification or implemented behavior. The existing [preview brief](PREVIEW.md) describes the implemented two-robot baseline. [HANDOFF.md](../HANDOFF.md) records source/release status and holds.

## Confirmed direction

Keep the cozy overhead room, actual coarse pixels, smooth accepted movement and watch-and-inspect interaction. The owner accepts the current room composition, layout and explanations; wording can be refined later. Give each event its own recognizable illustration while connecting events through their actual task. Show sanitized task descriptions in logs and the inspector opened by selecting an agent. Task identifiers stay internal; task hyperlinks are not required. Room text, robot labels and paper artwork remain free of task identifiers.

Show the existing core roles, with an Orchestrator boss coordinating work, and expandable worker seats. The selected starting capacity is four Developer seats plus an overflow annex. Multiple Developer workers may run concurrently under the same Developer GitHub App; an App identity is not a worker identity. Keep distinct task paths and worker assignments rather than animating the whole room as one shared task.

Release review units are settled: documentation cleanup → finish PR #44 → office extension. Retain current public copy as the default, with wording refinement later. The selected protection strategy is a controlled QA-App approval-counting test, then the final ruleset if it counts or the agreed check-based fallback. These selections do not authorize publication, merge, workflow enablement, paid runs or changes to held IAM access.

## Accepted station arrangement

The owner accepted this station arrangement and the inspection/log behavior on 2026-10-25: boss at the back, shared Developer bench and perimeter specialist desks; agent inspection offers task-filtered logs with an obvious All events option. Exact native-grid geometry and visual verification remain implementation work.

Preserve the woodland envelope, warm floor, short walls, windows, plants and clear central aisle. Recompose the interior for the core team before adding decorative detail. Accepted station placement:

```text
                     woodland windows
  ┌───────────────────────────────────────────────────┐
  │ Source library    Orchestrator boss + task board   │
  │ Scraper station          [owner approval inbox]    │
  │                                                   │
  │ Shared Developer workbench       QA + CI bench     │
  │ [seat] [seat] [seat] [seat]        [test machinery]  │
  │                                                   │
  │        clear handoff aisle / independent paths     │
  │                                                   │
  │ Router mail intake          Docs desk / archive    │
  │       entrance              [filing] [deploy lift] │
  └─────────────────────────┬─────────────────────────┘
                            └─ expandable worker annex
```

This diagram records accepted station relationships, not final tile coordinates or a requirement to squeeze everything into the current 320×256 canvas. Test native-grid density and phone readability in a labeled fictional composition before locking dimensions. Retain integer drawing coordinates, nearest-neighbor presentation, separate scenery/actor layers and the accepted one-native-pixel motion bound. Room text stays in semantic HTML around the scene.

| Role or facility | Visual proposal | Meaning and boundary |
|---|---|---|
| Orchestrator boss | Blue-slate robot, broad antenna/cap silhouette, task board at upper centre | Routes and assigns verified tasks, waits for real results and escalates. It never invents progress or grants owner approval. |
| Developer workers | Teal robots, square head and tool-belt silhouette at stable bench seats | Each active worker receives a stable identity and assignment. Small non-text details distinguish seats; logs and inspector describe the task in words. |
| QA | Amber robot, round lens silhouette, right-hand inspection bench | Reviews the actual task/head; requested changes return that task's packet to its assigned worker. |
| Scraper-builder | Sage robot, book/scoop silhouette, left source library | Builds or repairs source extractors. A station/robot does not imply a scraping run is active. |
| Docs-keeper | Plum robot, folded-paper silhouette, lower-right desk/archive | Receives a linked child task at merge and follows its own PR lifecycle; it need not wait for deployment. |
| Router / Categorizer | Cream robot with envelope silhouette, lower-left mail intake | Represents verified routing/categorization work when that runtime exists. Keep its planned status visible until connected. |
| CI machinery | Test rack with lamp/checking motion beside QA | Automated tests, not another AI agent. Distinguish running, failed and passed without relying on color alone. |
| Deploy machinery | Small package lift/outbound dock near archive | A separate verified deployment result; it does not file unmerged work or stand in for a person. |
| Owner approval inbox | Distinct human-marked tray by boss board | Public-safe indication that owner action is required. Approval remains an owner-only action in the existing private controls. |

The owner accepted the local room draft, including its current native size and role appearances, as the visual baseline. Preserve teal Developer and amber QA recognition. No Architect or Designer role is added. Inspection, focus outlines, role controls and structured text carry meaning when colors or tiny sprite details are hard to distinguish.

## Connected tasks and concurrent workers

Assign a task's packet to its verified task identity and the actual worker/run attempt. Persistent ownership, station, paper state and transition queue belong to that task; a new unrelated event does not erase another task's room state. A rework loop returns to the assigned worker where that assignment is still valid. A new attempt retains task continuity while recording its own run/attempt identity.

Proposed seat rule: retain an active Developer worker's seat for its execution; reuse the vacated seat only after an authoritative completion/reassignment update. Persist the mapping across polling/reconnects for that execution. A later run or new worker is not silently treated as the old one. Runtime assignment establishes identity; sprite position, title similarity, animation timing and the shared GitHub App cannot establish it.

The four visible seats describe scene capacity, not an increased deployment or spend limit. Keep the existing global limit of four in-flight task PRs, including Docs, unless separately changed; four Developer seats do not reserve four additional execution slots. An active worker beyond the displayed capacity belongs to the overflow annex if a future authorized runtime configuration supplies it; queued work stays explicitly queued at intake and is not drawn as an active spawned worker. An annex may limit simultaneous sprites for readability, but every worker and task remains selectable through accessible role controls, inspector and logs. Core stations persist as scenery, but workers are labeled idle only when a fresh authoritative snapshot supports it. Show an honest active/queued count only when supported by fresh state.

Concurrent tasks keep independent state machines and per-worker event ordering. Stagger paths or use reserved aisle lanes so one handoff does not teleport or cancel another. A busy aisle can delay an illustration, not drop its recorded event or mutate the authoritative task state. Keep pending transitions visible in inspector/logs; show visual lag if rendering falls behind. Design bounded queues/backpressure and retained event retrieval before implementation so overload cannot silently lose events. The latest-20 public replay window is not a lossless lifetime log.

## Public data contract proposal

The implemented public API exposes only id/time/agent/type/title. It cannot safely support this connected design by itself. Define and review a new server-produced sanitized contract before adding task continuity or concurrency to production.

The detailed source-grounded [live-data contract proposal](LIVE-CONTRACT.md) now specifies the projection/playback module split, private-task grouping policy, commit ordering, freshness, execution evidence, bounded queues and recovery. Its first local types/validation unit is implemented and tested without production imports. Technical defaults beyond that parser remain proposals; the accepted visual and privacy choices are settled.

| Proposed public data | Purpose and privacy requirement |
|---|---|
| Opaque stable task reference | Groups permitted events for the same public task; maps server-side to internal task identity. This is data correlation, not a hyperlink; keep the reference out of rendered UI. Show the sanitized task description in logs/agent details. |
| Opaque parent reference and relation kind | Links a Docs child to the merged task, or an actual planner child to its parent, without merging their lifecycle states. |
| Opaque worker reference plus role | Identifies an actual runtime worker/assignment independently of the GitHub App. No account, process, host or internal DB identifier is exposed. |
| Opaque run/attempt reference | Separates executions, retries and worker replacement while retaining task context. No raw Actions run IDs or internal correlation keys are required in the public payload. |
| Event ID, recorded timestamp, ordering/cursor | Supports dedupe, deterministic ordering, replay and recovery. Preserve original timestamps and distinguish receipt from recorded time. |
| Safe event type, sanitized title and bounded display summary | Allows only reviewed structured facts; preserve Private task redaction and existing sanitizer rules. |
| Authoritative active-state snapshot, revision and observed time | Establishes current task/worker assignments, queue/active/paused/wait/terminal state and data freshness. Events alone cannot prove inactivity. |
| History completeness/cursor metadata | Distinguishes an intact sequence from a truncated latest-20 window or a delivery gap. It never supplies invented missing starts. |

Use a server-side projection with explicit allowlists, role-limited access, opaque mapping lifecycle and tests. Never publish raw prompts, owner requests, code, CI/job logs, essay text, error strings, secrets or environment data. Public logs here mean structured sanitized event records. Do not derive public summaries from arbitrary log lines. The owner selected connected private-task histories and animations with descriptions hidden: logs/details show only “Private task,” while public tasks show sanitized descriptions. Private task references still group the actual task rather than merging all redacted work; identifiers remain internal and task hyperlinks are omitted. This permits relationship continuity, not disclosure of private content. Retention, reference lifetime and revocation remain technical contract work.

Active snapshots need a defined source of truth, refresh cadence, liveness signals and stale thresholds. After a fetch failure or expired freshness window, retain the last observed scene with a visible stale/unknown state; an empty incremental response must not mark workers idle, tasks done or machines offline. A genuinely idle scene needs a fresh snapshot establishing no active work. “Offline” requires a verified runtime state, not absence of events. Reconnect reconciles assignments/revisions before animating buffered transitions.

## Event illustrations within a task

Each row proposes a distinct illustration. Only received structured facts may trigger it; unspecified start/completion facts remain unknown. Illustrations explain work and are not a second authority for task status.

| Structured event or state | Illustration proposal | State retained |
|---|---|---|
| Task assigned / actual planning | Boss selects a packet at the board and sends it to the assigned seat | Actual task/parent/worker relation; queued tasks remain at intake until assignment. |
| Coding | Assigned Developer types; a few discrete tool/paper gestures | This worker's packet remains at its bench; other workers continue independently. |
| PR opened | Assigned Developer carries the packet into the review intake | The PR belongs to the correlated task; no shared title inference. |
| CI running | Packet passes through the test rack; lamps cycle | Machinery is running tests, not QA approval. |
| Tests failed | Rack rejects the packet with a visible failure symbol | Return it to the assigned worker for an actual fix attempt; terminal failure is separate. |
| CI passed | Rack shows a check and moves packet to the QA waiting tray | Passing tests does not invent a review or merge. |
| QA reviewing | Amber QA reads/inspects the packet at the review bench | Bind to the task/run/head facts; a new tested head needs the existing fresh CI/review cycle. |
| Changes requested | QA marks a revision sheet and returns that packet | Keep the connected task and actual subsequent worker assignment. |
| Approved | QA places a check-stamped packet on a ready tray | Approved work remains unfiled until merged. |
| Merged | Verified merged packet reaches the cabinet and is filed | Only this event files work; retain the merged task in its log. Start the linked Docs child when dispatched. |
| Deployed | Deploy lift sends a package outward and marks a verified result | Separate from merge and Docs. A deployment event must first be implemented/reported; absence is unknown. |
| Docs assigned / coding / PR / review / merge | Plum Docs robot uses its own packet at the archive desk and normal review machinery | Child lifecycle runs parallel to deploy after the parent's merge, with an explicit parent link in inspector/logs. Its merge files only its own packet and does not recursively create another Docs task. |
| Scraper assignment / coding | Sage worker inspects a source book/fixture and works at its desk | Reflect real extractor-development events; planned pipeline capability does not imply a live scrape. |
| Router / Categorizer work | Mail intake sorts an envelope into reviewed routing slots | Animate only supported runtime events; classification uncertainty remains visible. |
| Waiting on owner | Packet rests in human approval tray; boss waits | Show action required without animating approval or exposing private request text. |
| Paused | A pause marker holds the affected work in place | Distinguish system pause, visitor playback pause and owner wait. No inferred cancellation. |
| Cancelled | Packet is closed/withdrawn to a separate cancellation tray | Never file as merged; preserve recorded cancellation and late usage. |
| Terminal failure | Packet stays at a marked failure tray; worker stops active work when authoritative state confirms it | Failure is distinct from a retryable test failure; no fabricated rework. |
| Stale / unknown / unsupported | Last known scene with a restrained unknown indicator and readable explanation | Retain recorded text and last observation; invent no motion, result or idle/offline state. |

## Live, replay and visitor controls

Mode is a whole-scene property: Live, Replay or Fictional sample. Never animate some workers from current snapshots while other workers appear historically active without an explicit scene-wide transition. A fresh live arrival takes priority and switches the whole scene back to reconciled live state; preserve the interrupted replay position for an intentional later return. Live mode may show stale data, which must be marked separately from replay.

Replay uses up to the latest 20 recorded events, keeps original timestamps and may start mid-task. Show “Partial task history” in the inspector/log context when its beginning is absent; initialize unknown states instead of fabricating assignment, coding or prior handoffs. Historical snapshots may support a coherent replay baseline if available; otherwise keep only evidence-derived historical state. A modern live snapshot cannot fill a historical gap. Logs and the clicked inspector show sanitized task descriptions in every mode; correlation references remain internal.

Retain enabled Play, Pause/Resume, Next and the still reduced-motion default with explicit full-motion override. Hidden/offscreen views suspend visual timing without catch-up jumps; current live data can still be reconciled when visible. Manual stepping applies to the selected event/scene while preserving other task state. Motion may take longer under slow rendering; do not jump pixels to catch up. Restart affects replay/sample playback, not actual task execution.

## Inspector and log proposal

Keep the current understandable layout: room with playback controls, then inspector alongside on wide screens and below on phones. Open inspection by selecting an agent or its accessible role/seat control. Keep the event log readable and filterable by selected agent/task, with an all-events view and full original timestamps. A filter changes the text/inspection view, not the authoritative scene or other tasks' execution.

Illustrative fictional inspector, not a live observation:

```text
Developer · seat 2                  [Live]
State: Coding a requested revision
Task: Add health endpoint
Related task: —
Last confirmed: 2026-10-26 04:12:08 UTC
Data: Current                     [Show task events]
```

Illustrative fictional structured log:

```text
2026-10-26 04:12:08 UTC  Developer · seat 2  Add health endpoint  Coding
2026-10-26 04:12:09 UTC  QA                  Update navigation   Reviewing
2026-10-26 04:12:12 UTC  Developer · seat 2  Add health endpoint  PR opened
```

The first and third records belong to one task; the QA record belongs to another and does not move the first packet. These are fictional descriptions. Internal correlation, rather than matching descriptions, establishes task identity even when two tasks have the same wording. Task descriptions are plain text without task hyperlinks. Role controls and room labels contain role/seat/state only. Distinguish current data from partial replay and stale observations in semantic text. Use accessible 44px targets and keyboard focus; provide all task/worker inspection even when an overflow sprite is hidden. Refine wording later without reopening the accepted layout.

## Ordered implementation proposal

1. Complete the agreed documentation review unit, then finish PR #44 and its formal visual/release checks. Review the office extension separately; this draft is not publication approval.
2. Render the accepted station arrangement at native size in a labeled fictional composition; verify density and phone presentation, then lock canvas/tile coordinates after it reads clearly.
3. Specify and privacy-review opaque task/worker/run correlation, parent relations, authoritative snapshots, freshness and history recovery. Define public/private projection, retention and worker lifecycle before schema/API changes.
4. Implement the data projection and authoritative state/reconciliation model with synthetic tests for concurrent tasks, stable assignment, retries, stale snapshots, out-of-order/duplicate events and reconnects. Preserve existing sanitized-feed access controls and owner-critical change review.
5. Build the full-team room and individual event illustrations against clearly fictional connected fixtures: four Developer seats, active overflow, queued work, QA/rework, parallel Docs/deploy and every failure/wait/pause/cancel path. Verify actual coarse pixels, smooth motion, independent queues, log/inspector completeness and phone/keyboard access.
6. Connect approved projection to live/replay scene management, retaining the latest-20 replay policy, explicit partial-history handling, original timestamps, live priority, empty/error/cache recovery and accessible text. Keep the fictional sample separate.
7. Run focused state/privacy/renderer/browser checks and appropriate exact-head build/release checks; review Safari/physical-phone gaps. With held prerequisites separately resolved, validate actual populated correlated events and stop/usage behavior. Verify production only after scoped publication/merge/deployment approval.

## Remaining draft decisions

- The owner accepted the 384×304 room and expandable 384×96 annex as the local visual baseline, including current silhouettes/colors, station arrangement and inspection/log behavior. Further visual refinement should preserve that accepted composition.
- The public/private display policy is settled: connect events for both public and private tasks, showing sanitized public descriptions or “Private task” respectively. Define reference lifetime, worker/run lifecycle, snapshot freshness threshold and event-history recovery/retention. These technical contract decisions do not permit raw internal identifiers or private content.
- The owner selected playing every transition in sequence. Preserve each task/worker's ordered transitions without skipping to the latest state to drain a backlog; independent workers may animate concurrently. Distinguish the displayed event/time and queued transitions from the latest authoritative state in logs/details. Existing scene-wide live priority and explicit scene-mode changes remain; they do not silently discard interrupted transitions. Define bounded buffering/recovery before implementation, with explicit recovery when history is unavailable. The proposed 30-second freshness threshold remains unconfirmed. Confirm which future routing/categorization and deployment events will supply trustworthy animations.

## Local fictional implementation

The owner authorized the local visual draft. `/office/draft` now implements this arrangement with a provisional 384×304 native room and expandable 384×96 annex. The inspector sits beside the room from 1150px and below on narrower screens. Existing `/office` and `/office/preview` remain unchanged.

The finite fictional story contains 41 ordered events, independent task packets, four Developer seats and an annex assignment after a slot is released. It never exceeds four in-flight tasks including Docs. Task descriptions are plain text in logs/details, task references stay internal, and task filters retain an All events view. Automatic playback illustrates every transition; manual Next advances one event and settles its illustration. Merge alone files each packet; Docs follows its own lifecycle after its parent merges, independently of deployment. Reduced motion starts still with an explicit Play override; actual-room offscreen suspension and pause/resume remain.

Working-tree validation: five unit tests, five Chrome browser tests, web typecheck and scoped ESLint pass. Independent 320/390/1440 captures show no horizontal overflow, JavaScript errors or buttons below 44px. The full 41-event interaction check verifies filters, annex, restart, paused/offscreen pixel stability and resume. The finish review scored the event-heading correction resolved, with disposition `ship` for that local-draft fix scope only. Two inherited palette advisories remain nonblocking. Documentation comparison preserved the incumbent visual system and introduced no raster assets.

The owner accepted this local visual draft and asked to continue. Private-event continuity with hidden descriptions is selected. Authoritative freshness, reference/worker lifecycle and durable buffering/recovery remain design work before live integration. No schema, API, workflow, IAM or public publication changes occurred. Safari/Firefox, physical phones and production/OpenNext packaging at this working tree remain unverified. See [HANDOFF.md](../HANDOFF.md) for delivery state and holds.
