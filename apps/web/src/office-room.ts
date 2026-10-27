import type { OfficeEvent, OfficeExecution, OfficeRole, TaskRef } from "./office-contract";
import type { PlaybackEvent, PlaybackView } from "./office-playback";
import { HEIGHT, PEOPLE, type Actor, type Kind, type Point, type Scene } from "./app/(public)/office/draft/scene";
import type { OfficeRender } from "./app/(public)/office/draft/draw-office";

export const ROLE_ACTOR: Record<OfficeRole, Actor> = { orchestrator: "boss", developer: "dev1", qa: "qa", scraper: "scraper", docs: "docs", router: "router" };
export const ROLE_LABEL: Record<OfficeRole, string> = { orchestrator: "Orchestrator", developer: "Developer", qa: "QA", scraper: "Scraper-builder", docs: "Docs-keeper", router: "Router / Categorizer" };
const CORE: Actor[] = ["boss", "qa", "scraper", "docs", "router"];
export function executionActor(execution: OfficeExecution): Actor | null {
  const a = execution.assignment;
  if (!a) return null;
  if (execution.role !== "developer") return ROLE_ACTOR[execution.role];
  if (a.station === "annex") return "extra";
  return a.seat ? `dev${a.seat}` as Actor : null;
}
export function executionLabel(execution: OfficeExecution): string {
  const a = execution.assignment;
  const role = execution.role === "developer" ? "Developer" : PEOPLE[ROLE_ACTOR[execution.role]].name;
  return `${role}${a?.station === "annex" ? ` · annex seat ${a.seat ?? "unknown"}` : a?.seat ? ` · seat ${a.seat}` : ""}`;
}
export const eventLabel = (event: OfficeEvent) => ({ task_assigned: "Assigned", coding: "Coding reported", pr_opened: "PR opened", ci_running: "Checks running", tests_failed: "Tests failed", ci_passed: "Checks passed", qa_reviewing: "QA reviewing", changes_requested: "Changes requested", approved: "Approved · awaiting merge", merged: "Merged", deployed: "Deployed", waiting_on_owner: "Waiting on owner", failed: "Needs attention" })[event.type];
const kindFor = (e: OfficeEvent): Kind => ({ task_assigned: "assigned", qa_reviewing: "reviewing", waiting_on_owner: "waiting" } as Partial<Record<OfficeEvent["type"], Kind>>)[e.type] ?? e.type as Kind;
interface Packet { position: Point; filed: boolean; failed: boolean }
function emptyScene(): Scene {
  return { index: 0, elapsed: 0, settled: true, done: false,
    positions: Object.fromEntries(Object.entries(PEOPLE).map(([key, person]) => [key, { ...person.home }])) as Record<Actor, Point>,
    paths: Object.fromEntries(Object.keys(PEOPLE).map(key => [key, [] as Point[]])) as Record<Actor, Point[]> };
}
/** Geometry stores references and facts, never descriptions. Labels must always
 * come from the current epoch's controller view. Snapshots never invent packets. */
export class OfficeRoom {
  scene = emptyScene();
  private packets = new Map<TaskRef, Packet>();
  private assignments = new Map<string, Actor>();
  private active: { ref: PlaybackEvent["ref"]; task: TaskRef | null; actor: Actor | null; kind: Kind | "queued"; target: Point; pickup: Point | null; carrying: boolean } | null = null;
  private mode: PlaybackView["mode"] = "live";
  private generation: string | null = null;
  private replayIndex = 0;
  private eventTasks = new Map<string, TaskRef>();
  private savedLive: { scene: Scene; packets: Map<TaskRef, Packet>; assignments: Map<string, Actor>; eventTasks: Map<string, TaskRef>; deployed: boolean; waiting: boolean } | null = null;
  private deployed = false;
  private waiting = false;
  reset(): void { this.clear(); this.savedLive = null; }
  private clear(): void { this.scene = emptyScene(); this.packets = new Map(); this.assignments = new Map(); this.eventTasks = new Map(); this.active = null; this.deployed = false; this.waiting = false; }
  reconcile(view: PlaybackView): void {
    if (view.generation !== this.generation) this.reset();
    else if (view.mode !== this.mode) {
      if (this.mode === "live") this.savedLive = { scene: structuredClone(this.scene), packets: structuredClone(this.packets), assignments: new Map(this.assignments), eventTasks: new Map(this.eventTasks), deployed: this.deployed, waiting: this.waiting };
      const saved = this.savedLive;
      this.clear();
      if (view.mode === "live" && saved) { this.scene = saved.scene; this.packets = saved.packets; this.assignments = saved.assignments; this.eventTasks = saved.eventTasks; this.deployed = saved.deployed; this.waiting = saved.waiting; }
    } else if (view.mode === "replay" && view.replay.index < this.replayIndex) this.clear();
    this.mode = view.mode; this.generation = view.generation; this.replayIndex = view.replay.index;
    if (view.mode === "live") for (const e of view.current?.snapshot.executions ?? []) {
      const actor = executionActor(e); if (actor) this.assignments.set(e.ref, actor);
    }
    for (const event of [...view.log, ...view.pending, ...view.replay.events, ...(view.active ? [view.active] : [])]) {
      if ("deleted" in event) {
        const task = this.eventTasks.get(event.ref); if (task) this.packets.delete(task);
        const savedTask = this.savedLive?.eventTasks.get(event.ref); if (savedTask) this.savedLive?.packets.delete(savedTask);
      } else if (event.task_ref) this.eventTasks.set(event.ref, event.task_ref);
    }
    if (this.active && (!view.active || view.active.ref !== this.active.ref)) this.active = null;
    if (view.active && "deleted" in view.active && this.active?.ref === view.active.ref) {
      if (this.active.task) this.packets.delete(this.active.task);
      this.active = null; this.scene.paths = Object.fromEntries(Object.keys(PEOPLE).map(key => [key, [] as Point[]])) as Record<Actor, Point[]>;
    }
    if (!view.active || this.active?.ref === view.active.ref) return;
    const e = view.active;
    if ("deleted" in e) { this.active = { ref: e.ref, task: null, actor: null, kind: "queued", target: { x: 0, y: 0 }, pickup: null, carrying: false }; this.scene.settled = true; return; }
    const actor = this.mode === "replay" ? (e.role === "developer" ? null : ROLE_ACTOR[e.role]) : e.execution_ref ? this.assignments.get(e.execution_ref) ?? (e.role === "developer" ? null : ROLE_ACTOR[e.role]) : e.role === "developer" ? null : ROLE_ACTOR[e.role];
    const kind = kindFor(e);
    const home = actor ? PEOPLE[actor].home : { x: 74, y: 204 };
    const slot = e.task_ref && this.packets.has(e.task_ref) ? [...this.packets.keys()].indexOf(e.task_ref) : this.packets.size;
    const reviewPoint = { x: 312 + (slot % 4) * 3, y: 178 + (Math.floor(slot / 4) % 4) * 3 };
    const target = kind === "merged" ? { x: 276, y: 264 } : kind === "pr_opened" ? reviewPoint : kind === "waiting" ? { x: 246, y: 98 } : home;
    const previousPacket = e.task_ref ? this.packets.get(e.task_ref) : undefined;
    const carries = ["assigned", "coding", "pr_opened", "changes_requested", "tests_failed", "merged", "waiting", "failed"].includes(kind);
    const pickupPoint = carries && previousPacket && !previousPacket.filed ? { x: previousPacket.position.x - 2, y: previousPacket.position.y + 10 } : null;
    this.active = { ref: e.ref, task: e.task_ref, actor, kind, target, pickup: pickupPoint, carrying: carries && actor !== null && pickupPoint === null };
    this.scene.elapsed = 0; this.scene.settled = false;
    this.scene.paths = Object.fromEntries(Object.keys(PEOPLE).map(key => [key, [] as Point[]])) as Record<Actor, Point[]>;
    if (actor) {
      const from = this.scene.positions[actor];
      const route = (origin: Point, destination: Point): Point[] => {
        if (origin.x === destination.x && origin.y === destination.y) return [];
        const aisle = origin.y > HEIGHT || destination.y > HEIGHT ? 286 : 202;
        return actor === "boss" ? [{ x: destination.x, y: origin.y }, destination] : [{ x: origin.x, y: aisle }, { x: destination.x, y: aisle }, destination];
      };
      this.scene.paths[actor] = [...(pickupPoint ? route(from, pickupPoint) : []), ...route(pickupPoint ?? from, target)];
    }
  }
  tick(delta: number): boolean {
    if (!this.active || this.scene.settled || delta <= 0) return this.scene.settled;
    const actor = this.active.actor;
    if (actor) {
      const p = this.scene.positions[actor], path = this.scene.paths[actor];
      while (path[0] && path[0].x === p.x && path[0].y === p.y) { if (this.active.pickup?.x === p.x && this.active.pickup?.y === p.y) this.active.carrying = true; path.shift(); }
      const to = path[0];
      if (to) this.scene.positions[actor] = { x: p.x + Math.sign(to.x - p.x), y: p.y + (to.x === p.x ? Math.sign(to.y - p.y) : 0) };
    }
    this.scene.elapsed += Math.min(delta, 1000 / 60);
    this.scene.settled = (!actor || this.scene.paths[actor].length === 0) && this.scene.elapsed >= 1400;
    return this.scene.settled;
  }
  settle(): void {
    if (this.active?.actor) { this.active.carrying = true; this.scene.positions[this.active.actor] = { ...this.active.target }; this.scene.paths[this.active.actor] = []; }
    this.scene.elapsed = 1400; this.scene.settled = true;
  }
  complete(): void {
    const a = this.active; if (!a) return;
    if (a.task && a.kind !== "deployed" && (a.actor || a.kind === "merged")) {
      const previous = this.packets.get(a.task);
      const review = ["pr_opened", "ci_running", "ci_passed", "reviewing", "approved"].includes(a.kind);
      this.packets.set(a.task, { position: review && a.kind !== "pr_opened" ? previous?.position ?? { x: 314, y: 168 } : { x: a.target.x + 2, y: a.target.y - 10 }, filed: previous?.filed === true || a.kind === "merged", failed: a.kind === "failed" || a.kind === "tests_failed" });
    }
    if (a.kind === "deployed") this.deployed = true;
    this.waiting = a.kind === "waiting";
    this.active = null;
  }
  render(view: PlaybackView): OfficeRender {
    const active = this.active;
    const actors = new Set<Actor>([...CORE, ...this.assignments.values()]);
    if (view.mode === "live") for (const e of view.current?.snapshot.executions ?? []) { const a = executionActor(e); if (a) actors.add(a); }
    if (active?.actor) actors.add(active.actor);
    const running = view.mode === "live" && view.freshness === "fresh" && view.current?.capabilities.execution_observations === true
      ? (view.current.snapshot.executions ?? []).filter(e => e.phase === "running" && e.observation?.source === "trusted_work_job").map(executionActor).filter((a): a is Actor => a !== null) : [];
    return { beat: { actor: active?.actor ?? "boss", kind: active?.kind ?? "queued" }, actors: [...actors], working: view.mode === "replay" && active?.kind === "coding" && active.actor ? [active.actor] : running,
      statuses: {}, filed: Math.min(6, [...this.packets.values()].filter(p => p.filed).length), waiting: this.waiting, deployed: this.deployed,
      packets: [...this.packets.entries()].filter(([ref, p]) => !p.filed && !(active?.carrying && active.task === ref)).map(([, p]) => ({ position: p.position, failed: p.failed })).concat(active?.actor && active.carrying && active.kind !== "queued" ? [{ position: { x: this.scene.positions[active.actor].x + 2, y: this.scene.positions[active.actor].y - 10 }, failed: active.kind === "tests_failed" || active.kind === "failed" }] : []) };
  }
}
