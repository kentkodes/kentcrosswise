// Model usage of the planner and public-title nodes, per task (DESIGN §11 Q13(1)).
//
// A provider reports usage through the `onUsage` callback it was built with, which knows nothing
// about tasks. `trackPlannerUsage` binds the two: its `planner()` wrapper runs every node call in
// an AsyncLocalStorage context holding the request's task id, and its `onUsage` (given to the
// provider) reads that id and records the call. Child task threads started in the same invocation
// get their own ids, since each node call carries its own `PlanRequest.task_id`.
import { AsyncLocalStorage } from "node:async_hooks";
import type { CallCallback, CallEvent, UsageCallback, UsageRecord } from "@kcw/core/models";
import type { Plan, PlanRequest, Planner } from "../graph/types";

/** Writes one usage row (e.g. `usage_events` with kind `model`, `cost_usd` null). */
export type RecordTaskUsage = (taskId: number, usage: UsageRecord) => Promise<void>;

export interface PlannerUsageTracker {
  /** Pass to the provider the planner uses. */
  onUsage: UsageCallback;
  /** The planner whose calls are attributed to their request's task. */
  planner(inner: Planner): Planner;
}

/**
 * A usage row that fails to write fails the node call (and so the step; SQS redelivers it), like
 * any other DB error. Usage reported outside a wrapped call (no task) is logged and not recorded.
 */
export function trackPlannerUsage(record: RecordTaskUsage, log?: (line: string) => void): PlannerUsageTracker {
  const current = new AsyncLocalStorage<number>();
  return {
    onUsage: async (usage) => {
      const taskId = current.getStore();
      if (taskId === undefined) {
        log?.(`model usage outside a task (${usage.provider}/${usage.model}): not recorded`);
        return;
      }
      await record(taskId, usage);
    },
    planner: (inner) => ({
      split: (req: PlanRequest): Promise<string[]> => current.run(req.task_id, () => inner.split(req)),
      plan: (req: PlanRequest): Promise<Plan> => current.run(req.task_id, () => inner.plan(req)),
    }),
  };
}

/** Writes one call event (PgTaskStore.recordCall with agent `orchestrator`), AR3. */
export type RecordPlannerCall = (event: CallEvent) => Promise<void>;

export interface PlannerCallTracker {
  /** Pass to the provider the planner uses (option `onCall`), instead of `onUsage`. */
  onCall: CallCallback;
  /** The planner whose calls are attributed to their request's task. */
  planner(inner: Planner): Planner;
}

/**
 * AR3 successor of trackPlannerUsage: every request of the planner's provider (each retry attempt,
 * failed and unknown ones too) is written as a call record with purpose `plan` and the request's
 * task id, unless the call set them itself. A call outside a wrapped node call is still recorded,
 * without a task (it may be billed), and logged. A write that fails fails the node call (and so the
 * step; SQS redelivers it); a failed start write stops the call before it is sent.
 */
export function trackPlannerCalls(record: RecordPlannerCall, log?: (line: string) => void): PlannerCallTracker {
  const current = new AsyncLocalStorage<number>();
  return {
    onCall: async (event) => {
      const taskId = current.getStore();
      if (taskId === undefined && event.phase === "start") log?.(`model call outside a task (${event.provider}): recorded without a task`);
      const tag = { purpose: "plan", ...(taskId !== undefined && { taskId }), ...event.tag };
      await record({ ...event, tag });
    },
    planner: (inner) => ({
      split: (req: PlanRequest): Promise<string[]> => current.run(req.task_id, () => inner.split(req)),
      plan: (req: PlanRequest): Promise<Plan> => current.run(req.task_id, () => inner.plan(req)),
    }),
  };
}
