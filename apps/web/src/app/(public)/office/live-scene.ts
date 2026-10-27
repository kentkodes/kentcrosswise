import type { ActivityEvent } from "../_site/activity";
import { poseFor, walk } from "./preview/scene";
import type { EventKind, Point, Pose, Role } from "./preview/scene";

const HOME = { developer: { x: 80, y: 100 }, qa: { x: 240, y: 100 } };
const KINDS = new Set<string>(["task_assigned", "coding", "pr_opened", "ci_running", "tests_failed", "ci_passed", "qa_reviewing", "changes_requested", "approved", "merged", "deployed", "waiting_on_owner", "failed"]);
const MOVING = new Set<EventKind>(["pr_opened", "tests_failed", "changes_requested", "merged", "waiting_on_owner"]);
export const neutralPose = (): Pose => ({ ...HOME, paper: "none", filed: false });

// Event identity/title never establishes task continuity. These are isolated illustrations.
export function motionKind(event?: ActivityEvent): EventKind | undefined {
  return event && ["developer", "qa", "orchestrator"].includes(event.agent) && KINDS.has(event.type) ? event.type as EventKind : undefined;
}
export function motionRole(kind?: EventKind): Role | undefined {
  if (!kind || kind === "deployed") return undefined;
  return ["ci_running", "tests_failed", "ci_passed", "qa_reviewing", "changes_requested", "approved", "merged"].includes(kind) ? "qa" : "developer";
}
function atHome(pose: Pose): boolean {
  return (["developer", "qa"] as const).every(role => pose[role].x === HOME[role].x && pose[role].y === HOME[role].y);
}
function returnPoint(from: Point, to: Point, progress: number): Point {
  if (from.x === to.x && from.y === to.y) return to;
  return walk([from, { x: from.x, y: 128 }, { x: to.x, y: 128 }, to], progress);
}
function returnPose(from: Pose, progress: number): Pose {
  const developer = returnPoint(from.developer, HOME.developer, progress);
  const qa = returnPoint(from.qa, HOME.qa, progress);
  return { developer, qa, paper: "none", filed: false,
    walking: progress < 1 ? from.developer.x !== HOME.developer.x || from.developer.y !== HOME.developer.y ? "developer" : "qa" : undefined };
}
function actionPose(kind: EventKind | undefined, progress: number): Pose {
  // A deployment event alone is not evidence of a merge in this independent vignette.
  return !kind || kind === "deployed" ? neutralPose() : poseFor(kind, progress);
}
export interface Vignette {
  kind?: EventKind;
  phase: "return" | "action" | "hold";
  elapsed: number;
  from: Pose;
  pose: Pose;
  done: boolean;
}
export function beginVignette(event?: ActivityEvent, previous: Pose = neutralPose()): Vignette {
  const kind = motionKind(event);
  const phase = atHome(previous) ? "action" : "return";
  return { kind, phase, elapsed: 0, from: previous,
    pose: phase === "return" ? returnPose(previous, 0) : actionPose(kind, 0), done: !event };
}
export function advanceVignette(state: Vignette, delta: number): Vignette {
  if (state.done || delta <= 0) return state;
  const duration = state.phase === "return" ? 6000 : state.phase === "hold" ? 1000 : state.kind && MOVING.has(state.kind) ? 6000 : 4000;
  const elapsed = Math.min(duration, state.elapsed + Math.min(delta, 1000 / 60));
  const progress = elapsed / duration;
  const pose = state.phase === "return" ? returnPose(state.from, progress) : state.phase === "action" ? actionPose(state.kind, progress) : state.pose;
  if (elapsed < duration) return { ...state, elapsed, pose };
  if (state.phase === "return") return { ...state, phase: "action", elapsed: 0, pose: actionPose(state.kind, 0) };
  if (state.phase === "action") return { ...state, phase: "hold", elapsed: 0, pose };
  return { ...state, elapsed, pose, done: true };
}
