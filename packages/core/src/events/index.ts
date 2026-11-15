// Agent event types (DESIGN §4.4) and the report message agents send to the orchestrator queue
// (kcw-report, P2-03). Defined once here; the DB CHECK constraints in migration 0002 mirror these lists.

/** Agents that appear in `agent_events.agent` and `usage_events.agent` (§3.2). */
export const AGENTS = ["orchestrator", "developer", "qa", "scraper", "docs", "router"] as const;
export type AgentName = (typeof AGENTS)[number];

/** Office animation events, in the order a happy-path task goes through them (§4.4). */
export const EVENT_TYPES = [
  "task_assigned",
  "coding",
  "pr_opened",
  "ci_running",
  "tests_failed",
  "ci_passed",
  "qa_reviewing",
  "changes_requested",
  "approved",
  "merged",
  "deployed",
  "waiting_on_owner",
  "failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export function isAgentName(x: unknown): x is AgentName {
  return typeof x === "string" && (AGENTS as readonly string[]).includes(x);
}

export function isEventType(x: unknown): x is EventType {
  return typeof x === "string" && (EVENT_TYPES as readonly string[]).includes(x);
}

/** One usage line; maps to one `usage_events` row (`kind` = the row's kind). Cost is computed by the reader from `model_prices`. In a report each line also carries its `call` identity (`ReportUsage`). */
export type Usage =
  | { kind: "model"; provider: string; model: string; input_tokens: number; output_tokens: number }
  | { kind: "actions_minutes"; minutes: number };

/** The workflow job that sends a report (AR2 slice 3): the start job, or the final report job. */
export const REPORT_JOBS = ["start", "end"] as const;
export type ReportJob = (typeof REPORT_JOBS)[number];

/** The workflow job whose model execution produced a usage line: the work job or QA's review job. */
export const CALL_JOBS = ["work", "review"] as const;
export type CallJob = (typeof CALL_JOBS)[number];

/**
 * The identity of one usage line inside its run attempt: the job that made the calls and the line's
 * index in that job's immutable usage artifact. Together with the report's run id and attempt it is
 * stable across retries of the same report and distinct for separate calls (a model name or an
 * array position alone is not an identity).
 */
export interface UsageCall {
  job: CallJob;
  index: number;
}

export type ReportUsage = Usage & { call: UsageCall };

/**
 * What `kcw-report` puts on the orchestrator queue (AR2 slice 3). The identity (`run_id`,
 * `run_attempt`, `job`, `op`) comes from trusted workflow context: the runner's run id and attempt,
 * the sending job, and the dispatch operation id of the trusted prepare context (null only for the
 * undispatched scraper). A report carries an event, usage, or both. A usage-only report (no
 * `event_type`, DESIGN §11 Q14(5)) records usage and adds no lifecycle event.
 */
export interface AgentReport {
  /** `tasks.id` (a positive integer; the LangGraph thread is `task-<id>`). */
  task_id: number;
  agent: AgentName;
  run_id: number;
  run_attempt: number;
  job: ReportJob;
  op: number | null;
  /** Optional when `usage` is present: a usage-only report has no lifecycle event. */
  event_type?: EventType;
  /** Optional; omitted when the step used no model and no billed minutes. Required without `event_type`. */
  usage?: ReportUsage[];
}

/**
 * The logical identity of a report: its SQS MessageDeduplicationId and the orchestrator's receipt
 * key. A re-run of the workflow (a new attempt) is a new report.
 */
export function reportKey(r: Pick<AgentReport, "run_id" | "run_attempt" | "job">): string {
  return `report:${r.run_id}:${r.run_attempt}:${r.job}`;
}

/** `usage_events.dedupe_key` of one usage line of a report. */
export function usageKey(r: Pick<AgentReport, "run_id" | "run_attempt">, call: UsageCall): string {
  return `report:${r.run_id}:${r.run_attempt}:${call.job}:${call.index}`;
}

/** LangGraph thread id of a task (§4.3); also the SQS FIFO MessageGroupId. */
export function threadIdOf(taskId: number): string {
  return `task-${taskId}`;
}

export class ReportFormatError extends Error {
  override name = "ReportFormatError";
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isName = (v: unknown): v is string => typeof v === "string" && /^[\w.:/-]{1,100}$/.test(v);

function parseCall(c: unknown, i: number): UsageCall {
  if (!isObject(c) || !(CALL_JOBS as readonly unknown[]).includes(c.job) ||
      typeof c.index !== "number" || !Number.isSafeInteger(c.index) || c.index < 0 || c.index > 99) {
    throw new ReportFormatError(`usage[${i}] needs call {job: work|review, index: 0..99}`);
  }
  return { job: c.job as CallJob, index: c.index };
}

function parseUsage(u: unknown, i: number): ReportUsage {
  if (!isObject(u)) throw new ReportFormatError(`usage[${i}] must be an object`);
  return { ...parseUsageLine(u, i), call: parseCall(u.call, i) };
}

function parseUsageLine(u: Record<string, unknown>, i: number): Usage {
  if (u.kind === "model") {
    if (!isName(u.provider) || !isName(u.model)) {
      throw new ReportFormatError(`usage[${i}] needs provider and model`);
    }
    if (!isCount(u.input_tokens) || !isCount(u.output_tokens)) {
      throw new ReportFormatError(`usage[${i}] token counts must be non-negative integers`);
    }
    return { kind: "model", provider: u.provider, model: u.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens };
  }
  if (u.kind === "actions_minutes") {
    if (typeof u.minutes !== "number" || !Number.isFinite(u.minutes) || u.minutes < 0) {
      throw new ReportFormatError(`usage[${i}] minutes must be a non-negative number`);
    }
    return { kind: "actions_minutes", minutes: u.minutes };
  }
  throw new ReportFormatError(`usage[${i}] kind must be "model" or "actions_minutes"`);
}

const isPositive = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= max;

/**
 * Validates an untrusted report (the orchestrator's input, or the CLI's own output) and returns
 * a copy with only the known fields. A report without its identity (the format before AR2 slice 3)
 * is rejected: it cannot be applied exactly once. Error messages never quote the input.
 */
export function parseAgentReport(x: unknown): AgentReport {
  if (!isObject(x)) throw new ReportFormatError("report must be an object");
  const { task_id, agent, run_id, run_attempt, job, op, event_type, usage } = x;
  if (typeof task_id !== "number" || !Number.isSafeInteger(task_id) || task_id < 1) {
    throw new ReportFormatError("task_id must be a positive integer");
  }
  if (!isAgentName(agent)) throw new ReportFormatError(`agent must be one of ${AGENTS.join(", ")}`);
  if (!isPositive(run_id, Number.MAX_SAFE_INTEGER) || !isPositive(run_attempt, 2147483647)) {
    throw new ReportFormatError("run_id and run_attempt must be positive integers");
  }
  if (!(REPORT_JOBS as readonly unknown[]).includes(job)) throw new ReportFormatError("job must be start or end");
  if (op !== null && (typeof op !== "number" || !Number.isSafeInteger(op) || op < 0 || op > 999_999_999)) {
    throw new ReportFormatError("op must be null or an integer of at most 9 digits");
  }
  if (event_type !== undefined && !isEventType(event_type)) {
    throw new ReportFormatError(`event_type must be one of ${EVENT_TYPES.join(", ")}`);
  }
  const id = { task_id, agent, run_id, run_attempt, job: job as ReportJob, op: op as number | null };
  const out: AgentReport = event_type === undefined ? id : { ...id, event_type };
  if (usage !== undefined) {
    if (!Array.isArray(usage)) throw new ReportFormatError("usage must be an array");
    if (usage.length > 100) throw new ReportFormatError("usage has more than 100 lines");
    if (usage.length > 0) out.usage = usage.map(parseUsage);
    const calls = new Set(out.usage?.map((u) => `${u.call.job}:${u.call.index}`));
    if (calls.size !== (out.usage?.length ?? 0)) throw new ReportFormatError("usage calls must be distinct");
  }
  if (out.event_type === undefined && out.usage === undefined) {
    throw new ReportFormatError("report needs an event_type, usage, or both");
  }
  return out;
}
