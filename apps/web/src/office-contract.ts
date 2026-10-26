// Local protocol unit only: not imported by the feed, room, routes or server.
// Entity refs are transport-only grouping keys, never labels/links. UUID shape does not
// prove random allocation. This validator cannot replace the server title sanitizer,
// authenticate cursors, establish liveness or reject stale *other* responses.
export const OFFICE_VERSION = 1;
export const OFFICE_LIMITS = { tasks: 256, executions: 256, relations: 256, invalidations: 256, page: 50, replay: 20, description: 60, cursor: 512, ordinal: 65535, annexSeats: 256 } as const;
export const OFFICE_ROLES = ["orchestrator", "developer", "qa", "scraper", "docs", "router"] as const;
export const OFFICE_EVENT_TYPES = ["task_assigned", "coding", "pr_opened", "ci_running", "tests_failed", "ci_passed", "qa_reviewing", "changes_requested", "approved", "merged", "deployed", "waiting_on_owner", "failed"] as const;
export const OFFICE_TASK_STATES = ["queued", "planning", "in_progress", "waiting", "merged", "done", "failed", "cancelled"] as const;
const WAITING_ON = ["dev", "ci", "qa", "owner", "deploy"] as const;
const PHASES = ["unknown", "starting", "running", "terminal"] as const;
const OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
const SOURCES = ["trusted_start_report", "trusted_work_job", "trusted_workflow"] as const;
const VISIBILITIES = ["public", "private"] as const;
const COMPLETENESS = ["complete", "partial", "unknown"] as const;
export type OfficeRole = (typeof OFFICE_ROLES)[number];
export type OfficeEventType = (typeof OFFICE_EVENT_TYPES)[number];
export type OfficeTaskState = (typeof OFFICE_TASK_STATES)[number];
export type Visibility = (typeof VISIBILITIES)[number];
export type TaskRef = `task_${string}`;
export type ExecutionRef = `exec_${string}`;
export type EventRef = `event_${string}`;
export type GenerationRef = `gen_${string}`;
// Exact canonical projection counters, not raw task/run/source-event IDs.
export type Revision = string;
export type PrivacyEpoch = string;
export interface OfficePosition { revision: Revision; ordinal: number }
export interface OfficeTask {
  ref: TaskRef; visibility: Visibility; description: string;
  kind: "work" | "docs" | null;
  state: OfficeTaskState | null; waiting_on: (typeof WAITING_ON)[number] | null;
  paused: boolean | null; role: OfficeRole | null; execution_ref: ExecutionRef | null;
}
export interface OfficeExecution {
  ref: ExecutionRef; task_ref: TaskRef | null; role: OfficeRole;
  assignment: { station: OfficeRole | "annex"; seat: number | null } | null;
  phase: (typeof PHASES)[number]; outcome: (typeof OUTCOMES)[number] | null;
  observation: { source: (typeof SOURCES)[number]; observed_at: string } | null;
  reported_activity: OfficeEventType | null; reported_at: string | null;
}
export interface OfficeRelation {
  task_ref: TaskRef; related_task_ref: TaskRef;
  kind: "docs_parent" | "planner_parent";
  visibility: Visibility; description: string;
}
export interface OfficeSnapshot {
  tasks: OfficeTask[] | null; executions: OfficeExecution[] | null; related_tasks: OfficeRelation[] | null;
  pause: { paused: boolean | null; observed_at: string | null };
}
export interface OfficeEvent {
  ref: EventRef; position: OfficePosition; recorded_at: string;
  role: OfficeRole; type: OfficeEventType;
  task_ref: TaskRef | null; execution_ref: ExecutionRef | null;
  visibility: Visibility; description: string;
}
export interface OfficeReplay {
  events: OfficeEvent[]; from: OfficePosition | null; through: OfficePosition | null;
  completeness: (typeof COMPLETENESS)[number];
}
export interface OfficeGap {
  reason: "cursor_unavailable" | "generation_changed" | "privacy_changed" | "deleted";
  from: OfficePosition | null; through: OfficePosition | null; recovery: "rebind" | "restart";
}
export interface OfficeHistory {
  mode: "bootstrap" | "incremental" | "state";
  generation: GenerationRef; privacy_epoch: PrivacyEpoch;
  from: OfficePosition | null; through: OfficePosition | null;
  // Bounded opaque token, not a source event ID. Binding/crypto is a server concern.
  cursor: string | null; watermark: OfficePosition; oldest_available: OfficePosition | null;
  has_more: boolean; completeness: (typeof COMPLETENESS)[number] | "gap";
  replay: OfficeReplay | null; gap: OfficeGap | null;
  // redact: earlier labels withdrawn, the task is private now ("Private task").
  // relabel: an earlier public label withdrawn, the task is public now under its current row.
  invalidations: { task_ref: TaskRef; kind: "redact" | "relabel" | "delete" }[];
}
export interface OfficeCapabilities { execution_observations: boolean | null; deployment_events: boolean | null; routing_events: boolean | null }
export interface AvailableOffice {
  version: 1; available: true; generation: GenerationRef; privacy_epoch: PrivacyEpoch;
  observed_at: string; revision: Revision; snapshot: OfficeSnapshot; events: OfficeEvent[];
  history: OfficeHistory; capabilities: OfficeCapabilities;
}
export interface UnavailableOffice {
  version: 1; available: false; generation: null; privacy_epoch: null;
  observed_at: null; revision: null; snapshot: null; events: [];
  history: null; capabilities: null;
}
export type OfficeEnvelope = AvailableOffice | UnavailableOffice;
export type OfficeValidationCode = "shape" | "version" | "limit" | "reference" | "timestamp" | "privacy" | "position" | "duplicate" | "association" | "metadata";
export type OfficeValidation = { ok: true; value: OfficeEnvelope } | { ok: false; code: OfficeValidationCode };
class Invalid extends Error { constructor(readonly code: OfficeValidationCode) { super(code); } }
const invalid = (code: OfficeValidationCode): never => { throw new Invalid(code); };
type Obj = Record<string, unknown>;
function object(input: unknown, keys: readonly string[]): Obj {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid("shape");
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return invalid("shape");
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key))) return invalid("shape");
  const output: Obj = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid("shape");
    output[key] = descriptor.value;
  }
  return output;
}
function array<T>(input: unknown, maximum: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(input)) return invalid("shape");
  if (input.length > maximum) return invalid("limit");
  if (Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) return invalid("shape");
  return Array.from({ length: input.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !("value" in descriptor)) return invalid("shape");
    return parse(descriptor.value);
  });
}
function bool(input: unknown): boolean { return typeof input === "boolean" ? input : invalid("shape"); }
function choice<const T extends readonly string[]>(input: unknown, options: T): T[number] {
  return typeof input === "string" && options.includes(input) ? input as T[number] : invalid("shape");
}
function nullable<T>(input: unknown, parse: (value: unknown) => T): T | null { return input === null ? null : parse(input); }
function integer(input: unknown, minimum: number, maximum: number): number {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= minimum && input <= maximum ? input : invalid("limit");
}
function counter(input: unknown): string {
  return typeof input === "string" && /^(?:0|[1-9][0-9]{0,19})$/.test(input) ? input : invalid("position");
}
function ref<P extends "task" | "exec" | "event" | "gen">(input: unknown, prefix: P): `${P}_${string}` {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  return typeof input === "string" && input.length <= 42 && new RegExp(`^${prefix}_${uuid}$`).test(input) ? input as `${P}_${string}` : invalid("reference");
}
function timestamp(input: unknown): string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input)) return invalid("timestamp");
  const milliseconds = Date.parse(input);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === input ? input : invalid("timestamp");
}
function description(input: unknown, visibility: Visibility): string {
  if (typeof input !== "string") return invalid("shape");
  if (input.length > OFFICE_LIMITS.description) return invalid("limit");
  if (visibility === "private") return input === "Private task" ? input : invalid("privacy");
  // Transport hygiene only. The server still checks contacts, private terms and all
  // existing public-title rules before projection; this is not a content sanitizer.
  return input.trim().length > 0 && /^[\x20-\x7e]+$/.test(input) ? input : invalid("privacy");
}
function position(input: unknown): OfficePosition {
  const x = object(input, ["revision", "ordinal"]);
  const result = { revision: counter(x.revision), ordinal: integer(x.ordinal, 0, OFFICE_LIMITS.ordinal) };
  if (result.revision === "0" && result.ordinal !== 0) return invalid("position");
  return result;
}
export function compareOfficePositions(a: OfficePosition, b: OfficePosition): number {
  const revision = BigInt(a.revision) - BigInt(b.revision);
  return revision < 0n ? -1 : revision > 0n ? 1 : Math.sign(a.ordinal - b.ordinal);
}
const equal = (a: OfficePosition | null, b: OfficePosition | null) => a === null || b === null ? a === b : compareOfficePositions(a, b) === 0;
function task(input: unknown): OfficeTask {
  const x = object(input, ["ref", "visibility", "description", "kind", "state", "waiting_on", "paused", "role", "execution_ref"]);
  const visibility = choice(x.visibility, VISIBILITIES);
  const result = { ref: ref(x.ref, "task"), visibility, description: description(x.description, visibility), kind: nullable(x.kind, (v) => choice(v, ["work", "docs"] as const)), state: nullable(x.state, (v) => choice(v, OFFICE_TASK_STATES)), waiting_on: nullable(x.waiting_on, (v) => choice(v, WAITING_ON)), paused: nullable(x.paused, bool), role: nullable(x.role, (v) => choice(v, OFFICE_ROLES)), execution_ref: nullable(x.execution_ref, (v) => ref(v, "exec")) };
  if (result.waiting_on !== null && result.state !== "waiting") return invalid("association");
  return result;
}
function execution(input: unknown): OfficeExecution {
  const x = object(input, ["ref", "task_ref", "role", "assignment", "phase", "outcome", "observation", "reported_activity", "reported_at"]);
  const role = choice(x.role, OFFICE_ROLES);
  const assignment = nullable(x.assignment, (v) => {
    const a = object(v, ["station", "seat"]);
    const station = choice(a.station, [...OFFICE_ROLES, "annex"] as const);
    const seat = nullable(a.seat, (n) => integer(n, 1, station === "annex" ? OFFICE_LIMITS.annexSeats : 4));
    if (station === "annex" ? role !== "developer" : station !== role) return invalid("association");
    if (seat !== null && role !== "developer") return invalid("association");
    return { station, seat };
  });
  const result = {
    ref: ref(x.ref, "exec"), task_ref: nullable(x.task_ref, (v) => ref(v, "task")), role, assignment,
    phase: choice(x.phase, PHASES), outcome: nullable(x.outcome, (v) => choice(v, OUTCOMES)),
    observation: nullable(x.observation, (v) => { const o = object(v, ["source", "observed_at"]); return { source: choice(o.source, SOURCES), observed_at: timestamp(o.observed_at) }; }),
    reported_activity: nullable(x.reported_activity, (v) => choice(v, OFFICE_EVENT_TYPES)), reported_at: nullable(x.reported_at, timestamp),
  };
  if ((result.reported_activity === null) !== (result.reported_at === null)) return invalid("association");
  if (result.phase === "unknown" && (result.observation !== null || result.outcome !== null)) return invalid("association");
  if (result.phase !== "unknown" && result.observation === null) return invalid("association");
  if ((result.phase === "terminal") !== (result.outcome !== null)) return invalid("association");
  if (result.phase === "starting" && !["trusted_start_report", "trusted_workflow"].includes(result.observation?.source ?? "")) return invalid("association");
  if (result.phase === "running" && result.observation?.source !== "trusted_work_job") return invalid("association");
  if (result.phase === "terminal" && result.observation?.source === "trusted_start_report") return invalid("association");
  return result;
}
function relation(input: unknown): OfficeRelation {
  const x = object(input, ["task_ref", "related_task_ref", "kind", "visibility", "description"]);
  const visibility = choice(x.visibility, VISIBILITIES);
  return { task_ref: ref(x.task_ref, "task"), related_task_ref: ref(x.related_task_ref, "task"), kind: choice(x.kind, ["docs_parent", "planner_parent"] as const), visibility, description: description(x.description, visibility) };
}
function snapshot(input: unknown): OfficeSnapshot {
  const x = object(input, ["tasks", "executions", "related_tasks", "pause"]);
  const p = object(x.pause, ["paused", "observed_at"]);
  const pause = { paused: nullable(p.paused, bool), observed_at: nullable(p.observed_at, timestamp) };
  if ((pause.paused === null) !== (pause.observed_at === null)) return invalid("association");
  return { tasks: nullable(x.tasks, (v) => array(v, OFFICE_LIMITS.tasks, task)), executions: nullable(x.executions, (v) => array(v, OFFICE_LIMITS.executions, execution)), related_tasks: nullable(x.related_tasks, (v) => array(v, OFFICE_LIMITS.relations, relation)), pause };
}
function event(input: unknown): OfficeEvent {
  const x = object(input, ["ref", "position", "recorded_at", "role", "type", "task_ref", "execution_ref", "visibility", "description"]);
  const visibility = choice(x.visibility, VISIBILITIES);
  const result = { ref: ref(x.ref, "event"), position: position(x.position), recorded_at: timestamp(x.recorded_at), role: choice(x.role, OFFICE_ROLES), type: choice(x.type, OFFICE_EVENT_TYPES), task_ref: nullable(x.task_ref, (v) => ref(v, "task")), execution_ref: nullable(x.execution_ref, (v) => ref(v, "exec")), visibility, description: description(x.description, visibility) };
  if (result.position.revision === "0") return invalid("position");
  if (result.task_ref === null && result.execution_ref !== null) return invalid("association");
  return result;
}
function replay(input: unknown): OfficeReplay {
  const x = object(input, ["events", "from", "through", "completeness"]);
  const result = { events: array(x.events, OFFICE_LIMITS.replay, event), from: nullable(x.from, position), through: nullable(x.through, position), completeness: choice(x.completeness, COMPLETENESS) };
  if (!equal(result.from, result.events[0]?.position ?? null) || !equal(result.through, result.events.at(-1)?.position ?? null)) return invalid("metadata");
  return result;
}
function gap(input: unknown): OfficeGap {
  const x = object(input, ["reason", "from", "through", "recovery"]);
  const result = { reason: choice(x.reason, ["cursor_unavailable", "generation_changed", "privacy_changed", "deleted"] as const), from: nullable(x.from, position), through: nullable(x.through, position), recovery: choice(x.recovery, ["rebind", "restart"] as const) };
  if (result.from && result.through && compareOfficePositions(result.from, result.through) > 0) return invalid("position");
  if (result.recovery === "rebind" && result.reason !== "privacy_changed") return invalid("metadata");
  return result;
}
function history(input: unknown): OfficeHistory {
  const x = object(input, ["mode", "generation", "privacy_epoch", "from", "through", "cursor", "watermark", "oldest_available", "has_more", "completeness", "replay", "gap", "invalidations"]);
  return {
    mode: choice(x.mode, ["bootstrap", "incremental", "state"] as const), generation: ref(x.generation, "gen"), privacy_epoch: counter(x.privacy_epoch),
    from: nullable(x.from, position), through: nullable(x.through, position), cursor: nullable(x.cursor, (v) => typeof v === "string" && v.length <= OFFICE_LIMITS.cursor && /^cur_[A-Za-z0-9_-]{16,508}$/.test(v) ? v : invalid("reference")),
    watermark: position(x.watermark), oldest_available: nullable(x.oldest_available, position), has_more: bool(x.has_more), completeness: choice(x.completeness, [...COMPLETENESS, "gap"] as const),
    replay: nullable(x.replay, replay), gap: nullable(x.gap, gap),
    invalidations: array(x.invalidations, OFFICE_LIMITS.invalidations, (v) => { const i = object(v, ["task_ref", "kind"]); return { task_ref: ref(i.task_ref, "task"), kind: choice(i.kind, ["redact", "relabel", "delete"] as const) }; }),
  };
}
function unique<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const output = new Map<string, T>();
  for (const item of items) { const value = key(item); if (output.has(value)) return invalid("duplicate"); output.set(value, item); }
  return output;
}
function validateConsistency(value: AvailableOffice): void {
  const { history: h, snapshot: s, capabilities: c } = value;
  if (h.generation !== value.generation || h.privacy_epoch !== value.privacy_epoch || h.watermark.revision !== value.revision) return invalid("metadata");
  if (h.oldest_available && compareOfficePositions(h.oldest_available, h.watermark) > 0) return invalid("position");
  const tasks = unique(s.tasks ?? [], (t) => t.ref);
  const executions = unique(s.executions ?? [], (e) => e.ref);
  const relations = s.related_tasks ?? [];
  unique(relations, (r) => `${r.task_ref}:${r.related_task_ref}:${r.kind}`);
  unique(h.invalidations, (i) => i.task_ref);
  // One privacy registry spans every representation, including withheld task
  // inventories. Redaction is applied before any old description can enter it.
  // A redact invalidation forces "Private task" for the task everywhere in the envelope. A
  // relabel needs the task's current public row in the inventory; that row is then the only
  // label allowed, so no withdrawn title can travel with it (no inventory: rejected).
  const labels = new Map<TaskRef, { visibility: Visibility; description: string }>();
  const registerLabel = (taskRef: TaskRef, visibility: Visibility, text: string) => {
    const previous = labels.get(taskRef);
    if (previous && (previous.visibility !== visibility || previous.description !== text)) return invalid("privacy");
    labels.set(taskRef, { visibility, description: text });
  };
  for (const invalidation of h.invalidations) if (invalidation.kind === "redact") registerLabel(invalidation.task_ref, "private", "Private task");
  for (const task of tasks.values()) registerLabel(task.ref, task.visibility, task.description);
  const seenExecutions = new Map<ExecutionRef, { task_ref: TaskRef | null; role: OfficeRole | null }>();
  const registerExecution = (executionRef: ExecutionRef, taskRef: TaskRef | null, role: OfficeRole | null) => {
    const previous = seenExecutions.get(executionRef);
    if (previous && (previous.task_ref !== null && taskRef !== null && previous.task_ref !== taskRef || previous.role !== null && role !== null && previous.role !== role)) return invalid("association");
    seenExecutions.set(executionRef, { task_ref: taskRef ?? previous?.task_ref ?? null, role: role ?? previous?.role ?? null });
  };
  const knownDescription = (taskRef: TaskRef, visibility: Visibility, text: string) => {
    const target = tasks.get(taskRef);
    if (s.tasks !== null && !target) return invalid("association");
    if (target && (target.visibility !== visibility || target.description !== text)) return invalid("privacy");
    registerLabel(taskRef, visibility, text);
  };
  for (const task of tasks.values()) {
    if (task.execution_ref !== null) registerExecution(task.execution_ref, task.ref, task.role);
    if (task.execution_ref !== null && s.executions !== null) {
      const execution = executions.get(task.execution_ref);
      if (!execution || execution.task_ref !== task.ref || task.role !== null && execution.role !== task.role) return invalid("association");
    }
  }
  for (const execution of executions.values()) {
    registerExecution(execution.ref, execution.task_ref, execution.role);
    if (execution.task_ref !== null && s.tasks !== null && !tasks.has(execution.task_ref)) return invalid("association");
    if (execution.observation && execution.observation.observed_at > value.observed_at || execution.reported_at && execution.reported_at > value.observed_at) return invalid("timestamp");
    if ((execution.phase === "running" || execution.phase === "terminal" || (execution.phase === "starting" && execution.observation?.source === "trusted_workflow")) && c.execution_observations !== true) return invalid("association");
  }
  for (const relation of relations) {
    if (relation.task_ref === relation.related_task_ref || s.tasks !== null && !tasks.has(relation.task_ref)) return invalid("association");
    knownDescription(relation.related_task_ref, relation.visibility, relation.description);
    if (relation.kind === "docs_parent") {
      const child = tasks.get(relation.task_ref);
      const parent = tasks.get(relation.related_task_ref);
      if (child?.kind !== null && child?.kind !== undefined && child.kind !== "docs" || parent?.kind === "docs") return invalid("association");
    }
  }
  if (s.pause.observed_at && s.pause.observed_at > value.observed_at) return invalid("timestamp");
  for (const invalidation of h.invalidations) {
    const task = tasks.get(invalidation.task_ref);
    if (invalidation.kind === "redact" && task && task.visibility !== "private") return invalid("privacy");
    if (invalidation.kind === "relabel" && (s.tasks === null || !task)) return invalid("association");
    if (invalidation.kind === "relabel" && task!.visibility !== "public") return invalid("privacy");
    if (invalidation.kind === "delete" && (task || [...executions.values()].some((e) => e.task_ref === invalidation.task_ref) || relations.some((r) => r.task_ref === invalidation.task_ref || r.related_task_ref === invalidation.task_ref))) return invalid("association");
    if (invalidation.kind === "delete" && h.gap?.reason !== "deleted") return invalid("metadata");
  }
  const allEvents = [...value.events, ...(h.replay?.events ?? [])];
  unique(allEvents, (e) => e.ref);
  unique(allEvents, (e) => `${e.position.revision}:${e.position.ordinal}`);
  for (const event of allEvents) {
    if (event.recorded_at > value.observed_at) return invalid("timestamp");
    if (compareOfficePositions(event.position, h.watermark) > 0) return invalid("position");
    if (event.task_ref !== null) {
      knownDescription(event.task_ref, event.visibility, event.description);
    }
    if (event.execution_ref !== null && s.executions !== null) {
      const execution = executions.get(event.execution_ref);
      if (!execution || execution.task_ref !== event.task_ref || execution.role !== event.role) return invalid("association");
    }
    if (event.execution_ref !== null) {
      registerExecution(event.execution_ref, event.task_ref, event.role);
    }
    if (event.type === "deployed" && c.deployment_events !== true || event.role === "router" && c.routing_events !== true) return invalid("association");
    const invalidation = h.invalidations.find((i) => i.task_ref === event.task_ref);
    if (invalidation?.kind === "delete" || invalidation?.kind === "redact" && event.visibility !== "private") return invalid("privacy");
  }
  for (const events of [value.events, h.replay?.events ?? []]) {
    for (let index = 1; index < events.length; index++) if (compareOfficePositions(events[index - 1]!.position, events[index]!.position) >= 0) return invalid("position");
  }
  if (h.gap) {
    if (h.completeness !== "gap" || h.has_more || h.cursor !== null || h.through !== null || value.events.length > 0 || h.replay !== null) return invalid("metadata");
    return;
  }
  if (h.completeness === "gap") return invalid("metadata");
  if (h.mode === "state") {
    if (value.events.length || h.replay !== null || h.from !== null || h.through !== null || h.cursor !== null || h.has_more) return invalid("metadata");
    return;
  }
  if (h.cursor === null) return invalid("metadata");
  if (h.mode === "bootstrap") {
    if (value.events.length || h.from !== null || !equal(h.through, h.watermark) || h.has_more) return invalid("metadata");
    return;
  }
  if (h.from === null || h.through === null || h.replay !== null) return invalid("metadata");
  const last = value.events.at(-1)?.position ?? h.from;
  if (!equal(h.through, last)) return invalid("metadata");
  if (compareOfficePositions(h.from, h.watermark) > 0 || value.events.some((e) => compareOfficePositions(e.position, h.from!) <= 0)) return invalid("position");
  if (h.has_more && (value.events.length === 0 || compareOfficePositions(h.through, h.watermark) >= 0)) return invalid("metadata");
}
/** Closed, bounded parser: no input values, property names or error text are returned on failure. */
export function parseOfficeEnvelope(input: unknown): OfficeValidation {
  try {
    const x = object(input, ["version", "available", "generation", "privacy_epoch", "observed_at", "revision", "snapshot", "events", "history", "capabilities"]);
    if (x.version !== OFFICE_VERSION) return invalid("version");
    if (!bool(x.available)) {
      if ([x.generation, x.privacy_epoch, x.observed_at, x.revision, x.snapshot, x.history, x.capabilities].some((v) => v !== null)) return invalid("metadata");
      if (array(x.events, 0, event).length !== 0) return invalid("metadata");
      return { ok: true, value: { version: 1, available: false, generation: null, privacy_epoch: null, observed_at: null, revision: null, snapshot: null, events: [], history: null, capabilities: null } };
    }
    const capabilities = object(x.capabilities, ["execution_observations", "deployment_events", "routing_events"]);
    const value: AvailableOffice = {
      version: 1, available: true, generation: ref(x.generation, "gen"), privacy_epoch: counter(x.privacy_epoch), observed_at: timestamp(x.observed_at), revision: counter(x.revision),
      snapshot: snapshot(x.snapshot), events: array(x.events, OFFICE_LIMITS.page, event), history: history(x.history),
      capabilities: { execution_observations: nullable(capabilities.execution_observations, bool), deployment_events: nullable(capabilities.deployment_events, bool), routing_events: nullable(capabilities.routing_events, bool) },
    };
    validateConsistency(value);
    return { ok: true, value };
  } catch (error) { return { ok: false, code: error instanceof Invalid ? error.code : "shape" }; }
}
