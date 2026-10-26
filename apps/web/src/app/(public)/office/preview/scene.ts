// Fictional choreography only. No public-feed or server imports.
export type Role = "developer" | "qa";
export type Scenario = "success" | "rework" | "tests" | "waiting" | "failure";
export type EventKind = "task_assigned" | "coding" | "pr_opened" | "ci_running" | "tests_failed" | "ci_passed" | "qa_reviewing" | "changes_requested" | "approved" | "merged" | "deployed" | "waiting_on_owner" | "failed";
export interface Beat { kind: EventKind; title: string; detail: string; role: Role; duration: number }
export function beatAt(beats: readonly Beat[], index: number): Beat {
  const beat = beats[index];
  if (!beat) throw new RangeError("Unknown sample event");
  return beat;
}
const beat = (kind: EventKind, title: string, detail: string, role: Role = "developer", duration = 3500): Beat => ({ kind, title, detail, role, duration });
const assigned = beat("task_assigned", "A small task arrives", "Sample task: add a welcome note to the studio.");
const coding = beat("coding", "Developer is coding", "The teal robot works at the left desk.");
const handoff = beat("pr_opened", "Papers go to QA", "Developer carries the sample pull request across the room.", "developer", 6000);
const checks = beat("ci_running", "Checks are running", "The papers wait at QA while automated checks run.", "qa");
const passed = beat("ci_passed", "Checks passed", "The sample checks are green. Review comes next.", "qa");
const review = beat("qa_reviewing", "QA is reviewing", "The amber robot checks the papers at the right desk.", "qa");
const approved = beat("approved", "QA approved the work", "Approval is not a merge. The papers stay on QA’s desk.", "qa");
const merged = beat("merged", "Merged and filed", "QA carries the merged papers to the cabinet.", "qa", 6000);
export const SCENARIOS: Record<Scenario, { label: string; beats: readonly Beat[] }> = {
  success: { label: "Successful delivery", beats: [assigned, coding, handoff, checks, passed, review, approved, merged, beat("deployed", "The change is deployed", "The completed sample is filed. Restart to watch again.", "qa")] },
  rework: { label: "Changes requested", beats: [assigned, coding, handoff, checks, passed, review, beat("changes_requested", "A revision comes back", "QA returns the marked papers to Developer.", "qa", 6000), coding, handoff, review, approved, merged] },
  tests: { label: "Tests fail", beats: [assigned, coding, handoff, checks, beat("tests_failed", "Tests need a fix", "QA returns the papers. Developer waits to fix the failing check.", "qa", 6000)] },
  waiting: { label: "Waiting on owner", beats: [assigned, coding, beat("waiting_on_owner", "Waiting for the owner", "Developer leaves the papers in the inbox. Work pauses for the owner.", "developer", 4500)] },
  failure: { label: "Task fails", beats: [assigned, coding, beat("failed", "The task stopped", "The sample task failed. Work stays unfiled; the robot is no longer busy.")] },
};
export const WIDTH = 320;
export const HEIGHT = 256;
export interface Point { x: number; y: number }
const DEV: Point = { x: 80, y: 100 };
const QA: Point = { x: 240, y: 100 };
const CABINET: Point = { x: 160, y: 96 };
const INBOX: Point = { x: 112, y: 120 };
const across = [DEV, { x: 80, y: 128 }, { x: 216, y: 128 }, { x: 216, y: 100 }];
const returnPapers = [QA, { x: 240, y: 128 }, { x: 104, y: 128 }, { x: 104, y: 100 }];
const toCabinet = [QA, { x: 240, y: 128 }, { x: 160, y: 128 }, CABINET];
const toInbox = [DEV, { x: 80, y: 120 }, INBOX];
export function walk(path: readonly Point[], progress: number): Point {
  const start = path[0];
  if (!start) throw new RangeError("A walking path needs a starting point");
  const segments: { from: Point; to: Point; length: number }[] = [];
  let from = start;
  for (const to of path.slice(1)) {
    segments.push({ from, to, length: Math.abs(to.x - from.x) + Math.abs(to.y - from.y) });
    from = to;
  }
  let distance = Math.max(0, Math.min(1, progress)) * segments.reduce((sum, segment) => sum + segment.length, 0);
  for (const segment of segments) {
    if (distance <= segment.length) {
      const ratio = segment.length ? distance / segment.length : 1;
      return { x: Math.round(segment.from.x + (segment.to.x - segment.from.x) * ratio), y: Math.round(segment.from.y + (segment.to.y - segment.from.y) * ratio) };
    }
    distance -= segment.length;
  }
  return from;
}
export interface Pose { developer: Point; qa: Point; carrying?: Role; paper: Role | "cabinet" | "inbox"; walking?: Role; filed: boolean }
export function poseFor(kind: EventKind, progress: number, previous?: Pose): Pose {
  const p = Math.max(0, Math.min(1, progress));
  const source = previous ?? { developer: DEV, qa: QA, paper: "developer" as const, filed: false };
  const devReturning = source.developer.x !== DEV.x || source.developer.y !== DEV.y;
  const qaReturning = source.qa.x !== QA.x || source.qa.y !== QA.y;
  const pose: Pose = {
    developer: devReturning ? walk([source.developer, { x: source.developer.x, y: 128 }, { x: 80, y: 128 }, DEV], p) : DEV,
    qa: qaReturning ? walk([source.qa, { x: source.qa.x, y: 128 }, { x: 240, y: 128 }, QA], p) : QA,
    paper: source.paper, filed: source.filed,
    walking: p < 1 ? devReturning ? "developer" : qaReturning ? "qa" : undefined : undefined,
  };
  if (kind === "task_assigned" || kind === "coding") return { ...pose, paper: "developer", filed: false };
  if (kind === "pr_opened") return { ...pose, developer: walk(across, p), carrying: p < 1 ? "developer" : undefined, walking: p < 1 ? "developer" : pose.walking, paper: "qa" };
  if (kind === "qa_reviewing") return { ...pose, paper: "qa", carrying: "qa" };
  if (["ci_running", "ci_passed", "approved"].includes(kind)) return { ...pose, paper: "qa" };
  if (kind === "merged") return { ...pose, qa: walk(toCabinet, p), carrying: p < 1 ? "qa" : undefined, walking: p < 1 ? "qa" : pose.walking, paper: "cabinet", filed: p === 1 };
  if (kind === "deployed") return { ...pose, paper: "cabinet", filed: true };
  if (kind === "changes_requested" || kind === "tests_failed") return { ...pose, qa: walk(returnPapers, p), carrying: p < 1 ? "qa" : undefined, walking: p < 1 ? "qa" : pose.walking, paper: "developer" };
  if (kind === "waiting_on_owner") return { ...pose, developer: walk(toInbox, p), carrying: p < 1 ? "developer" : undefined, walking: p < 1 ? "developer" : pose.walking, paper: "inbox" };
  return pose;
}
export function scenePose(beats: readonly Beat[], index: number, progress: number): Pose {
  let previous: Pose | undefined;
  for (let i = 0; i < index; i++) previous = poseFor(beatAt(beats, i).kind, 1, previous);
  return poseFor(beatAt(beats, index).kind, progress, previous);
}
export interface Clock { index: number; elapsed: number; done: boolean }
export const initialClock = (): Clock => ({ index: 0, elapsed: 0, done: false });
export function tick(clock: Clock, delta: number, beats: readonly Beat[]): Clock {
  if (clock.done || delta <= 0) return clock;
  const elapsed = clock.elapsed + delta;
  const duration = beatAt(beats, clock.index).duration;
  if (elapsed < duration) return { ...clock, elapsed };
  return clock.index === beats.length - 1 ? { ...clock, elapsed: duration, done: true } : { index: clock.index + 1, elapsed: 0, done: false };
}
export function next(clock: Clock, beats: readonly Beat[]): Clock {
  const index = Math.min(clock.index + 1, beats.length - 1);
  return { index, elapsed: beatAt(beats, index).duration, done: index === beats.length - 1 };
}
