// Fictional, finite choreography. No feed, runtime or private data is consumed here.
export const WIDTH = 384;
export const HEIGHT = 304;
export const ANNEX_HEIGHT = 96;
export type Actor = "boss" | "dev1" | "dev2" | "dev3" | "dev4" | "qa" | "scraper" | "docs" | "router" | "extra";
export type TaskKey = "health" | "navigation" | "source" | "approval" | "guide" | "annex";
export type Kind = "assigned" | "coding" | "pr_opened" | "ci_running" | "tests_failed" | "ci_passed" | "reviewing" | "changes_requested" | "approved" | "merged" | "deployed" | "waiting" | "paused" | "cancelled" | "failed";
export interface Point { x: number; y: number }
export const PEOPLE: Record<Actor, { name: string; job: string; color: string; home: Point }> = {
  boss: { name: "Orchestrator", job: "Coordinates assignments and escalates owner decisions.", color: "#92a7c4", home: { x: 200, y: 98 } },
  dev1: { name: "Developer · seat 1", job: "Builds the health endpoint and follows its revisions.", color: "#67baa6", home: { x: 106, y: 170 } },
  dev2: { name: "Developer · seat 2", job: "Works independently on the navigation change.", color: "#67baa6", home: { x: 154, y: 170 } },
  dev3: { name: "Developer · seat 3", job: "An available bench seat; it is not an active execution.", color: "#67baa6", home: { x: 202, y: 170 } },
  dev4: { name: "Developer · seat 4", job: "An available bench seat; it is not an active execution.", color: "#67baa6", home: { x: 250, y: 170 } },
  qa: { name: "QA", job: "Reviews the change. The adjacent rack runs automated tests.", color: "#e4ad55", home: { x: 330, y: 170 } },
  scraper: { name: "Scraper-builder", job: "Repairs source extractors at the library desk.", color: "#9eaf89", home: { x: 52, y: 114 } },
  docs: { name: "Docs-keeper", job: "Receives a related documentation task after merge, independent of deployment.", color: "#c4a2c7", home: { x: 302, y: 262 } },
  router: { name: "Router / Categorizer", job: "Planned intake station. No live routing connection is claimed.", color: "#eee4c7", home: { x: 54, y: 260 } },
  extra: { name: "Developer · annex", job: "A later assignment uses the annex after a slot becomes available.", color: "#67baa6", home: { x: 154, y: 370 } },
};
export const TASKS: Record<TaskKey, { description: string; worker: Actor; parent?: TaskKey }> = {
  health: { description: "Add a health endpoint", worker: "dev1" },
  navigation: { description: "Improve the mobile navigation", worker: "dev2" },
  source: { description: "Repair a source extractor", worker: "scraper" },
  approval: { description: "Review a protected configuration change", worker: "boss" },
  guide: { description: "Document the health endpoint", worker: "docs", parent: "health" },
  annex: { description: "Clarify the empty-state message", worker: "extra" },
};
export interface Beat { task: TaskKey; actor: Actor; kind: Kind; title: string; detail: string }
const b = (task: TaskKey, actor: Actor, kind: Kind, title: string, detail: string): Beat => ({ task, actor, kind, title, detail });
export const BEATS: readonly Beat[] = [
  b("health", "boss", "assigned", "A task leaves the board", "The Orchestrator assigns the health endpoint to Developer at seat 1."),
  b("health", "dev1", "coding", "The first change takes shape", "Developer at seat 1 starts coding. Each packet keeps its own task history."),
  b("navigation", "dev2", "coding", "A second worker starts independently", "Seat 2 works on mobile navigation while the first task remains at seat 1."),
  b("source", "scraper", "coding", "The library has its own work", "Scraper-builder repairs an extractor. This sample now has three in-flight tasks."),
  b("approval", "boss", "waiting", "A decision waits for the owner", "The human-marked approval tray holds a fourth task. The boss cannot approve it."),
  b("health", "dev1", "pr_opened", "The health change goes to review", "Developer carries this task’s packet through the aisle to the QA intake."),
  b("health", "qa", "ci_running", "Automated checks are running", "The test rack checks the health change. Machinery is separate from QA review."),
  b("health", "qa", "tests_failed", "A test finds a problem", "The rack marks this packet for repair; no task is filed."),
  b("health", "dev1", "coding", "Seat 1 repairs the failing test", "The same task returns to its assigned Developer. Other packets stay where they belong."),
  b("health", "dev1", "pr_opened", "A fresh revision is ready", "The revised health change returns to the review intake."),
  b("health", "qa", "ci_running", "Checks run on the new revision", "The test rack checks the revised health change before QA begins."),
  b("health", "qa", "ci_passed", "Fresh checks pass", "Passing checks do not imply QA approval or a merge."),
  b("health", "qa", "reviewing", "QA inspects the health change", "The amber robot reviews this task’s packet."),
  b("health", "qa", "changes_requested", "QA requests a small revision", "The marked packet returns through the aisle to seat 1."),
  b("navigation", "dev2", "pr_opened", "The navigation task is ready too", "Seat 2 hands over a different packet. The health task retains its own revision state."),
  b("navigation", "qa", "ci_running", "Navigation checks are running", "The rack tests the independent navigation packet."),
  b("navigation", "qa", "ci_passed", "Navigation checks pass", "This result belongs only to the navigation task."),
  b("navigation", "qa", "reviewing", "QA reviews the navigation change", "The review applies to the navigation packet, not the health revision."),
  b("navigation", "qa", "approved", "Navigation is approved", "The packet waits in the ready tray. Approval does not file it."),
  b("navigation", "qa", "merged", "Navigation is merged and filed", "Only the recorded merge carries this packet into the archive. One in-flight slot is released."),
  b("annex", "extra", "assigned", "The annex receives the next assignment", "A new worker starts after navigation completes. Four tasks remain in flight, not five."),
  b("annex", "extra", "coding", "Another seat, an independent task", "The annex worker clarifies an empty-state message. Expand the annex to watch; inspection always remains available."),
  b("source", "scraper", "paused", "Extractor work is paused", "This task pauses in place. Visitor playback and a task pause are separate states."),
  b("source", "scraper", "failed", "The extractor task needs attention", "A terminal failure is recorded. Its packet stays unfiled and releases its execution slot."),
  b("health", "dev1", "coding", "The requested revision is made", "Seat 1 continues the same health task after QA’s feedback."),
  b("health", "dev1", "pr_opened", "The revision returns to QA", "The task follows its own sequence without skipping earlier illustrations."),
  b("health", "qa", "ci_running", "Checks cover the requested revision", "The rack tests the current health revision before another review."),
  b("health", "qa", "ci_passed", "The revised checks pass", "Fresh checks cover the new revision."),
  b("health", "qa", "reviewing", "QA reviews the revision", "The review applies to the new revision rather than the previous attempt."),
  b("health", "qa", "approved", "The health change is approved", "The ready tray is not the filing cabinet."),
  b("health", "qa", "merged", "Health work is merged and filed", "Merge makes the related Docs task eligible. Deployment remains a separate result."),
  b("guide", "docs", "assigned", "Docs starts after the merge", "Docs-keeper receives a separate task: document the health endpoint."),
  b("guide", "docs", "coding", "Docs writes while deployment proceeds", "The related documentation task has its own packet and lifecycle."),
  b("health", "boss", "deployed", "The deploy lift delivers the change", "This deployment result neither files another packet nor completes the Docs task."),
  b("approval", "boss", "cancelled", "The protected change is withdrawn", "Cancellation uses a separate tray. The owner never approved this sample request."),
  b("guide", "docs", "pr_opened", "The guide goes to review", "Docs carries its own packet to QA, independently of its merged parent."),
  b("guide", "qa", "ci_running", "The guide checks are running", "The documentation task has its own automated checks."),
  b("guide", "qa", "ci_passed", "The guide checks pass", "The documentation change completes its own checks."),
  b("guide", "qa", "reviewing", "QA reviews the guide", "The guide receives its own review after its checks."),
  b("guide", "qa", "approved", "The guide is approved", "The Docs packet remains unfiled until its own merge."),
  b("guide", "qa", "merged", "The guide is merged and filed", "Only the guide’s own packet is filed. It does not spawn another Docs task."),
];
export const currentBeat = (index: number): Beat => {
  const beat = BEATS[index];
  if (!beat) throw new RangeError("Unknown fictional office event");
  return beat;
};
const review = { x: 312, y: 178 };
const archive = { x: 276, y: 264 };
const inbox = { x: 246, y: 98 };
export interface Scene { index: number; elapsed: number; settled: boolean; done: boolean; positions: Record<Actor, Point>; paths: Record<Actor, Point[]> }
function destination(beat: Beat): Point {
  if (beat.kind === "pr_opened") return review;
  if (beat.kind === "merged") return archive;
  if (beat.kind === "changes_requested" || beat.kind === "tests_failed") return PEOPLE[TASKS[beat.task].worker].home;
  if (beat.kind === "waiting" || beat.kind === "cancelled") return inbox;
  return PEOPLE[beat.actor].home;
}
function pathsFor(index: number, positions: Record<Actor, Point>): Record<Actor, Point[]> {
  const beat = currentBeat(index);
  return Object.fromEntries(Object.entries(PEOPLE).map(([key, person]) => {
    const actor = key as Actor;
    const from = positions[actor];
    const to = actor === beat.actor ? destination(beat) : person.home;
    const pickup = actor === "qa" && actor === beat.actor && ["tests_failed", "changes_requested", "merged"].includes(beat.kind);
    const path = pickup ? [review, { x: review.x, y: 202 }, { x: to.x, y: 202 }, to]
      : actor === "boss" ? [{ x: to.x, y: from.y }, to]
      : from.x === to.x && from.y === to.y ? [] : from.y > HEIGHT || to.y > HEIGHT
      ? [{ x: from.x, y: 286 }, { x: to.x, y: 286 }, to]
      : [{ x: from.x, y: 202 }, { x: to.x, y: 202 }, to];
    return [actor, path.filter((point, i) => i !== 0 || point.x !== from.x || point.y !== from.y)];
  })) as Record<Actor, Point[]>;
}
export function initialScene(): Scene {
  const positions = Object.fromEntries(Object.entries(PEOPLE).map(([key, person]) => [key, { ...person.home }])) as Record<Actor, Point>;
  return { index: 0, elapsed: 0, settled: false, done: false, positions, paths: pathsFor(0, positions) };
}
function advance(scene: Scene): Scene {
  if (scene.index === BEATS.length - 1) return { ...scene, settled: true, done: true };
  const index = scene.index + 1;
  return { ...scene, index, elapsed: 0, settled: false, paths: pathsFor(index, scene.positions) };
}
// One axis, one native pixel per animation update. A slow frame never skips an event.
export function tick(scene: Scene, delta: number): Scene {
  if (scene.done || delta <= 0) return scene;
  if (scene.settled) return advance(scene);
  const positions = { ...scene.positions };
  const paths = { ...scene.paths };
  for (const key of Object.keys(PEOPLE) as Actor[]) {
    const point = positions[key];
    const pending = [...paths[key]];
    while (pending[0] && pending[0].x === point.x && pending[0].y === point.y) pending.shift();
    const target = pending[0];
    if (target) positions[key] = { x: point.x + Math.sign(target.x - point.x), y: point.y + (target.x === point.x ? Math.sign(target.y - point.y) : 0) };
    paths[key] = pending;
  }
  const elapsed = scene.elapsed + Math.min(delta, 1000 / 60);
  const arrived = (Object.keys(PEOPLE) as Actor[]).every((key) => paths[key].every((point) => point.x === positions[key].x && point.y === positions[key].y));
  return { ...scene, positions, paths, elapsed, settled: arrived && elapsed >= 1400 };
}
// Explicit visitor stepping settles the current event; automatic playback never calls this.
export function nextEvent(scene: Scene): Scene {
  if (scene.done) return scene;
  const settle = (current: Scene): Scene => {
    const positions = { ...current.positions };
    for (const actor of Object.keys(PEOPLE) as Actor[]) positions[actor] = current.paths[actor].at(-1) ?? positions[actor];
    return { ...current, positions, paths: Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, [] as Point[]])) as Record<Actor, Point[]>, settled: true, elapsed: 1400, done: current.index === BEATS.length - 1 };
  };
  const current = settle(scene);
  return current.done ? current : settle(advance(current));
}
export interface TaskState { kind: Kind | "queued"; filed: boolean; actor: Actor; seen: boolean }
export function taskStates(scene: Scene): Record<TaskKey, TaskState> {
  const tasks = Object.fromEntries(Object.entries(TASKS).map(([key, task]) => [key, { kind: "queued", filed: false, actor: task.worker, seen: false }])) as Record<TaskKey, TaskState>;
  BEATS.slice(0, scene.index + 1).forEach((beat, i) => {
    const previous = tasks[beat.task];
    tasks[beat.task] = { kind: beat.kind, actor: beat.actor, seen: true, filed: previous.filed || beat.kind === "merged" && (i < scene.index || scene.settled) };
  });
  return tasks;
}
export function inFlight(scene: Scene): number {
  return Object.values(taskStates(scene)).filter((task) => task.seen && !["merged", "deployed", "failed", "cancelled"].includes(task.kind)).length;
}
export function actorTask(scene: Scene, actor: Actor): TaskKey | undefined {
  const beat = currentBeat(scene.index);
  if (beat.actor === actor) return beat.task;
  if (actor === "qa") return BEATS.slice(0, scene.index + 1).findLast((entry) => entry.actor === actor)?.task;
  return (Object.keys(TASKS) as TaskKey[]).find((key) => TASKS[key].worker === actor && taskStates(scene)[key].seen);
}
export const eventTime = (index: number) => `2026-10-25 18:${String(10 + Math.floor(index / 4)).padStart(2, "0")}:${String(index % 4 * 15).padStart(2, "0")} UTC`;
