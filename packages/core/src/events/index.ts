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

/** One usage line; maps to one `usage_events` row (`kind` = the row's kind). Cost is computed by the reader from `model_prices`. */
export type Usage =
  | { kind: "model"; provider: string; model: string; input_tokens: number; output_tokens: number }
  | { kind: "actions_minutes"; minutes: number };

/**
 * What `kcw-report` puts on the orchestrator queue: `{task_id, agent, event_type?, usage?}`.
 * A report carries an event, usage, or both. A usage-only report (no `event_type`, DESIGN §11
 * Q14(5)) records usage and adds no lifecycle event.
 */
export interface AgentReport {
  /** `tasks.id` (a positive integer; the LangGraph thread is `task-<id>`). */
  task_id: number;
  agent: AgentName;
  /** Optional when `usage` is present: a usage-only report has no lifecycle event. */
  event_type?: EventType;
  /** Optional; omitted when the step used no model and no billed minutes. Required without `event_type`. */
  usage?: Usage[];
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

function parseUsage(u: unknown, i: number): Usage {
  if (!isObject(u)) throw new ReportFormatError(`usage[${i}] must be an object`);
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

/**
 * Validates an untrusted report (the orchestrator's input, or the CLI's own output) and returns
 * a copy with only the known fields. Error messages never quote the input.
 */
export function parseAgentReport(x: unknown): AgentReport {
  if (!isObject(x)) throw new ReportFormatError("report must be an object");
  const { task_id, agent, event_type, usage } = x;
  if (typeof task_id !== "number" || !Number.isSafeInteger(task_id) || task_id < 1) {
    throw new ReportFormatError("task_id must be a positive integer");
  }
  if (!isAgentName(agent)) throw new ReportFormatError(`agent must be one of ${AGENTS.join(", ")}`);
  if (event_type !== undefined && !isEventType(event_type)) {
    throw new ReportFormatError(`event_type must be one of ${EVENT_TYPES.join(", ")}`);
  }
  const out: AgentReport = event_type === undefined ? { task_id, agent } : { task_id, agent, event_type };
  if (usage !== undefined) {
    if (!Array.isArray(usage)) throw new ReportFormatError("usage must be an array");
    if (usage.length > 0) out.usage = usage.map(parseUsage);
  }
  if (out.event_type === undefined && out.usage === undefined) {
    throw new ReportFormatError("report needs an event_type, usage, or both");
  }
  return out;
}
