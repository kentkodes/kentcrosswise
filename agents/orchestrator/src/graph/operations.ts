// Identities of the task's GitHub and planner effects (DESIGN §4.0, migration 0012). Keys come only
// from checkpointed state, so a step that is re-run computes the same key.
import { createHash } from "node:crypto";

export type OperationKind = "plan" | "issue" | "dispatch" | "merge";

/** `task-<id>/<kind>/<n>`: n counts the logical operations of that kind the task has finished or abandoned. */
export const effectKey = (taskId: number, kind: OperationKind, n: number): string => `task-${taskId}/${kind}/${n}`;

/** The content-free line that lets a re-run find the issue it already created (no private data). */
export const issueMarker = (key: string): string => `<!-- kcw-op: ${key} -->`;

/** The `run-name` of a developer, QA or docs workflow run (`<role> task <task_id>`). */
export const agentRunName = (role: "developer" | "qa" | "docs", taskId: number): string => `${role} task ${taskId}`;

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)]))
      : v;

/** sha256 over the request with object keys sorted, so equal requests hash equally. */
export const requestHash = (request: unknown): string => createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex");

/** The record under this key holds a different request: a contradiction that goes to the owner. */
export class OperationConflictError extends Error {
  override name = "OperationConflictError";
  constructor(readonly key: string) {
    super("operation_conflict");
  }
}
