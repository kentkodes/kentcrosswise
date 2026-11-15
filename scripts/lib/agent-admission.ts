// Run admission and publisher fencing for the dispatched agent workflows (AR2 slice 2b).
// The operation id `op` is the orchestrator's dispatch counter (key `task-<id>/dispatch/<n>`); it is
// in the run-name, so GitHub's own run history is the durable record: the run with the lowest id for a
// run-name is the one admitted to do work, and a run of the same workflow and task with a higher op
// supersedes an older one. No database access, no new secret.
import { ghGet, type GhOptions } from "./agent-github";
import type { WorkflowAgent } from "./agents";

// The first dispatch of a task is operation 0 (key `task-<id>/dispatch/0`).
const OP = /^(?:0|[1-9][0-9]{0,8})$/;

/** The dispatch input `op`: a decimal of 1..9 digits without leading zeros. Never echoes the value. */
export function parseOp(v: string | undefined): number {
  const t = (v ?? "").trim();
  if (!OP.test(t)) throw new Error("op must be a decimal integer of at most 9 digits");
  return Number(t);
}

/** `<role> task <id> op <n>`, the `run-name` of the three dispatched agent workflows. */
export const runTitle = (agent: WorkflowAgent, taskId: number, op: number): string => `${agent} task ${taskId} op ${op}`;

export interface RunRef { id: number; title: string }

/** Pure: this run is admitted only if it has the lowest id among the runs with its exact title. */
export function admission(runs: readonly RunRef[], title: string, runId: number): { admitted: boolean; first: number } {
  const ids = runs.filter((r) => r.title === title).map((r) => r.id);
  const first = Math.min(runId, ...ids);
  return { admitted: first === runId, first };
}

/** Pure: a run of the same task with a higher op exists (a newer operation supersedes this one). */
export function superseded(runs: readonly RunRef[], agent: WorkflowAgent, taskId: number, op: number): boolean {
  const re = new RegExp(`^${agent} task ${taskId} op (0|[1-9][0-9]{0,8})$`);
  return runs.some((r) => {
    const m = re.exec(r.title);
    return m !== null && Number(m[1]) > op;
  });
}

const PAGE = 100;
const MAX_PAGES = 5;

/** The newest `workflow_dispatch` runs on main of this agent's workflow (bounded: 5 pages of 100). */
export async function listDispatchRuns(gh: GhOptions, workflow: string): Promise<RunRef[]> {
  const out: RunRef[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghGet<{ workflow_runs?: { id: number; display_title?: string }[] }>(gh,
      `/repos/${gh.repo}/actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&per_page=${PAGE}&page=${page}`, "listing agent runs");
    const runs = res?.workflow_runs ?? [];
    for (const r of runs) if (Number.isSafeInteger(r.id) && typeof r.display_title === "string") out.push({ id: r.id, title: r.display_title });
    if (runs.length < PAGE) break;
  }
  return out;
}

export interface RunIdentity { agent: WorkflowAgent; workflow: string; taskId: number; op: number; runId: number }

/** Prepare: this run may do work only if it is the first run of its operation. */
export async function admit(gh: GhOptions, id: RunIdentity): Promise<{ admitted: boolean; first: number }> {
  return admission(await listDispatchRuns(gh, id.workflow), runTitle(id.agent, id.taskId, id.op), id.runId);
}

/** Publish: still admitted, and not superseded by a higher op. Null means publishing may proceed. */
export async function fence(gh: GhOptions, id: RunIdentity): Promise<"not_admitted" | "superseded" | null> {
  const runs = await listDispatchRuns(gh, id.workflow);
  if (!admission(runs, runTitle(id.agent, id.taskId, id.op), id.runId).admitted) return "not_admitted";
  return superseded(runs, id.agent, id.taskId, id.op) ? "superseded" : null;
}
