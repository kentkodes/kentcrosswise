// GitHub Actions minutes (P2-15, DESIGN §3.2): every `workflow_run.completed` delivery from an
// allowlisted sender becomes one usage_events(kind 'actions_minutes', cost_usd 0) row, deduped per
// run attempt. Minutes are the attempt's wall-clock duration (run_started_at -> updated_at), not
// GitHub's per-job billable minutes; on public repos with standard runners they cost $0 anyway.
import type { AgentName } from "@kcw/core/events";
import type { GitHubEventPayload } from "./normalize";

type WorkflowRunPayload = Extract<GitHubEventPayload, { type: "workflow_run" }>;

export interface ActionsMinutes {
  /** `github:workflow_run:<run id>:<attempt>`; one row per run attempt. */
  dedupeKey: string;
  agent: AgentName;
  /** Rounded to 2 decimals (the column is numeric(10,2)). */
  minutes: number;
  /** Completion time (`updated_at`), ISO 8601. */
  ts: string;
}

/** Agent workflows by file name; everything else (ci, deploy, preview-gc) counts as orchestrator. */
const AGENT_WORKFLOWS: Readonly<Record<string, AgentName>> = {
  "agent-developer.yml": "developer",
  "agent-qa.yml": "qa",
  "agent-scraper.yml": "scraper",
  "agent-docs.yml": "docs",
};

export function agentOfWorkflow(path: string | null): AgentName {
  const file = path?.split("/").pop() ?? "";
  return Object.hasOwn(AGENT_WORKFLOWS, file) ? AGENT_WORKFLOWS[file]! : "orchestrator";
}

/** One-day cap: longer than any Actions job may run (6 h) plus queueing; anything above is bad data. */
const MAX_MINUTES = 24 * 60;

/** The usage row for a completed run, or null when the payload has no usable start/end time. */
export function actionsMinutesOf(run: WorkflowRunPayload): ActionsMinutes | null {
  if (run.action !== "completed" || run.run_started_at === null || run.updated_at === null) return null;
  const start = Date.parse(run.run_started_at);
  const end = Date.parse(run.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const minutes = Math.round((end - start) / 600) / 100;
  if (minutes > MAX_MINUTES) return null;
  return {
    dedupeKey: `github:workflow_run:${run.run_id}:${run.run_attempt ?? 1}`,
    agent: agentOfWorkflow(run.workflow_path),
    minutes,
    ts: new Date(end).toISOString(),
  };
}
