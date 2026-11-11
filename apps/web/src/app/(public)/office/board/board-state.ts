// Pure derivation for the /office team board (Board tab): status pills, role cards, developer seats,
// the annex count and the activity list. No React and no clock: callers pass the playback view, and
// relative times are formatted from a timestamp the caller supplies. A private task never shows its
// description; its text is always "Private task".
import { compareOfficePositions, type OfficeEvent, type OfficeExecution, type OfficeRole, type OfficeSnapshot, type OfficeTask, type TaskRef } from "../../../../office-contract";
import { OfficePlayback, type PlaybackEvent, type PlaybackView } from "../../../../office-playback";
import { ROLE_LABEL, eventLabel } from "../../../../office-room";

export type BoardRole = "orchestrator" | "developer" | "qa" | "docs" | "scraper";
type CardRole = Exclude<BoardRole, "developer">;
/** "unknown": the state cannot be confirmed (no snapshot, or a withheld inventory). Drawn as a grey dot. */
export type Status = "working" | "waiting" | "idle" | "unknown";
export type Tone = "ok" | "warn" | "idle";
export type Seat = 1 | 2 | 3 | 4;
export const SEATS: readonly Seat[] = [1, 2, 3, 4];
/** Rows shown in the activity list, after filtering. */
export const ACTIVITY_LIMIT = 50;
/** A restart of a playback that reported a restart gap happens at most once in this window. */
export const RESTART_MIN_MS = 30_000;
export const UNKNOWN_TEXT = "Status unavailable";

/** Card copy and model tags. Constants, not read from the live API. */
export const CARD_INFO: Record<BoardRole, { title: string; what: string | null; model: string }> = {
  orchestrator: { title: ROLE_LABEL.orchestrator, what: "Plans tasks, assigns work, merges.", model: "Opus 5.5" },
  developer: { title: ROLE_LABEL.developer, what: null, model: "DeepSeek Flash" },
  qa: { title: ROLE_LABEL.qa, what: "Reviews pull requests after CI.", model: "Haiku 5.5" },
  docs: { title: ROLE_LABEL.docs, what: "Updates docs after a merge.", model: "DeepSeek Flash" },
  scraper: { title: ROLE_LABEL.scraper, what: "Builds essay source adapters.", model: "DeepSeek Flash" },
};

/** The state word shown in small mono capitals on every card and seat. */
export const STATUS_WORD: Record<Status, string> = { working: "Working", waiting: "Waiting", idle: "Idle", unknown: "Unknown" };
export const STATUS_TONE: Record<Status, Tone> = { working: "ok", waiting: "warn", idle: "idle", unknown: "idle" };

/** A card or seat reading. `text` may be empty (an idle seat shows only its state word). */
export interface Reading { status: Status; text: string }
export interface RoleCard extends Reading { lastEventAt: string | null }
export interface SeatReading extends Reading { seat: Seat }
export interface DeveloperCard {
  status: Status;
  seats: SeatReading[];
  annex: number;
  /** Running developer executions with no seat (assignment null, or station developer with seat null). */
  unassigned: number;
  /** "Waiting on <x>" for a developer wait that no seat shows; null otherwise. */
  waiting: string | null;
  lastEventAt: string | null;
}
export interface Roster { orchestrator: RoleCard; developer: DeveloperCard; qa: RoleCard; docs: RoleCard; scraper: RoleCard }
export interface Pill { tone: Tone; label: string }
export interface BoardPills { system: Pill | null; inFlight: number | null; feed: Pill | null }
export type ActivityState = "loading" | "unavailable" | "empty" | "list";
export interface Board {
  pills: BoardPills;
  /** Always present: cards render before the first response, with "Loading…" or "Status unavailable". */
  roster: Roster;
  /** Sanitized rows, newest first, deduplicated and uncapped. Read them with filterRows, which filters first and
   * then caps at ACTIVITY_LIMIT; no raw events leave this module.
   * `stale`: the feed is unavailable but rows from earlier responses are still shown. */
  activity: { state: ActivityState; replay: boolean; stale: boolean; rows: ActivityRow[] };
}

export type ActivityFilter = "all" | "orchestrator" | "developer" | "qa" | "docs" | "scraper";
export const ACTIVITY_FILTERS: readonly { value: ActivityFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "orchestrator", label: "Orchestrator" },
  { value: "developer", label: "Developer" },
  { value: "qa", label: "QA" },
  { value: "docs", label: "Docs" },
  { value: "scraper", label: "Scraper" },
];
export type ActivityRow =
  | { key: string; kind: "withdrawn" }
  | { key: string; kind: "event"; recordedAt: string; role: OfficeRole; roleLabel: string; label: string; text: string };

const IN_FLIGHT: ReadonlySet<string> = new Set(["queued", "planning", "in_progress", "waiting"]);
const RUNNING: ReadonlySet<string> = new Set(["starting", "running"]);
const WAITING_ON: Record<NonNullable<OfficeTask["waiting_on"]>, string> = { dev: "Developer", ci: "CI", qa: "QA", owner: "owner", deploy: "deploy" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const isRunning = (execution: OfficeExecution) => RUNNING.has(execution.phase);
/** A status cannot be confirmed without the execution inventory, and waits cannot be checked without tasks. */
const unknownInventory = (snapshot: OfficeSnapshot) => snapshot.executions === null || snapshot.tasks === null;

/** Everything the board draws, derived from one playback view. */
export function deriveBoard(view: PlaybackView): Board {
  const snapshot = view.current?.snapshot ?? null;
  const events = combinedEvents(view);
  // Cards and the list read the same combined source. The list keeps every row so a filter can reach older events.
  const live = view.log.length > 0 || view.pending.length > 0 || view.active !== null;
  const unknownText = view.availability === "unknown" ? "Loading…" : UNKNOWN_TEXT;
  return {
    pills: pillsFor(view, snapshot),
    roster: rosterFor(snapshot, events, unknownText),
    activity: {
      state: activityState(view, events),
      replay: !live && events.length > 0,
      stale: view.availability === "unavailable" && events.length > 0,
      rows: activityRows(events),
    },
  };
}

/** The board before the first playback view exists. */
export function loadingBoard(): Board {
  return deriveBoard(new OfficePlayback().view({ wallMs: 0, monoMs: 0 }));
}

/** Rows under one filter, newest first, at most ACTIVITY_LIMIT. The filter applies before the cap, so a quiet
 * role still shows its events. Withdrawn events have no role, so they appear only under All. */
export function filterRows(rows: readonly ActivityRow[], filter: ActivityFilter): ActivityRow[] {
  const matching = filter === "all" ? rows : rows.filter((row) => row.kind === "event" && row.role === filter);
  return matching.slice(0, ACTIVITY_LIMIT);
}

/** True when the playback reported a restart gap and no restart happened in the last RESTART_MIN_MS. */
export function shouldRestart(view: PlaybackView | null, lastRestartMono: number, nowMono: number): boolean {
  return view?.gap?.recovery === "restart" && nowMono - lastRestartMono >= RESTART_MIN_MS;
}

/** A key over the fields that change what the board shows. Equal keys mean nothing needs re-deriving. */
export function viewKey(view: PlaybackView): string {
  return [view.current?.revision ?? "", view.log.length, view.replay.events.length, view.pending.length, view.availability, view.freshness, view.gap?.reason ?? "", view.gap?.recovery ?? ""].join("|");
}

/** "Nov 11, 15:42 UTC". Built from the ISO string, so it is the same on the server and in the browser. */
export function utcLabel(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${hours}:${minutes} UTC`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". A timestamp in the future counts as just now. */
export function relativeTime(iso: string, nowMs: number): string {
  const minutes = Math.floor(Math.max(0, nowMs - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Live log and replay events, one entry per event ref (the live copy wins), newest first, uncapped. */
function combinedEvents(view: PlaybackView): PlaybackEvent[] {
  const seen = new Set<string>();
  const merged: PlaybackEvent[] = [];
  for (const event of [...view.log, ...view.replay.events]) {
    if (seen.has(event.ref)) continue;
    seen.add(event.ref);
    merged.push(event);
  }
  return merged.sort((a, b) => compareOfficePositions(b.position, a.position));
}

function activityRows(events: readonly PlaybackEvent[]): ActivityRow[] {
  return events.map((event): ActivityRow => "deleted" in event
    ? { key: event.ref, kind: "withdrawn" }
    : { key: event.ref, kind: "event", recordedAt: event.recorded_at, role: event.role, roleLabel: ROLE_LABEL[event.role], label: eventLabel(event), text: eventText(event) });
}

function pillsFor(view: PlaybackView, snapshot: OfficeSnapshot | null): BoardPills {
  return {
    system: systemPill(snapshot),
    inFlight: snapshot?.tasks ? snapshot.tasks.filter((task) => task.state !== null && IN_FLIGHT.has(task.state)).length : null,
    feed: view.availability === "unavailable" ? { tone: "warn", label: "Feed unavailable" } : view.freshness === "stale" ? { tone: "warn", label: "Updates delayed" } : null,
  };
}

/** Agrees with the cards: Working when something runs, Idle only when the inventories that prove idle are present. */
function systemPill(snapshot: OfficeSnapshot | null): Pill | null {
  if (!snapshot) return null;
  if (snapshot.pause.paused === true) return { tone: "warn", label: "Paused" };
  if (snapshot.executions?.some(isRunning)) return { tone: "ok", label: "Working" };
  return unknownInventory(snapshot) ? null : { tone: "idle", label: "Idle" };
}

function activityState(view: PlaybackView, events: readonly PlaybackEvent[]): ActivityState {
  if (events.length > 0) return "list";
  if (view.availability === "unavailable") return "unavailable";
  return view.current ? "empty" : "loading";
}

function rosterFor(snapshot: OfficeSnapshot | null, events: readonly PlaybackEvent[], unknownText: string): Roster {
  if (!snapshot) {
    const blank = (role: CardRole): RoleCard => ({ status: "unknown", text: unknownText, lastEventAt: newestFor(events, role)?.recorded_at ?? null });
    return {
      orchestrator: blank("orchestrator"),
      developer: {
        status: "unknown",
        seats: SEATS.map((seat) => ({ seat, status: "unknown", text: unknownText })),
        annex: 0,
        unassigned: 0,
        waiting: null,
        lastEventAt: newestFor(events, "developer")?.recorded_at ?? null,
      },
      qa: blank("qa"),
      docs: blank("docs"),
      scraper: blank("scraper"),
    };
  }
  return {
    orchestrator: roleCard("orchestrator", snapshot, events),
    developer: developerCard(snapshot, events),
    qa: roleCard("qa", snapshot, events),
    docs: roleCard("docs", snapshot, events),
    scraper: roleCard("scraper", snapshot, events),
  };
}

function roleCard(role: CardRole, snapshot: OfficeSnapshot, events: readonly PlaybackEvent[]): RoleCard {
  return { ...roleReading(role, snapshot, events), lastEventAt: newestFor(events, role)?.recorded_at ?? null };
}

function roleReading(role: CardRole, snapshot: OfficeSnapshot, events: readonly PlaybackEvent[]): Reading {
  const working = (snapshot.executions ?? []).find((execution) => execution.role === role && isRunning(execution));
  if (working) return { status: "working", text: executionText(snapshot, working) };
  const waiting = (snapshot.tasks ?? []).find((task) => task.role === role && task.state === "waiting");
  if (waiting) return { status: "waiting", text: waitingText(waiting) };
  if (unknownInventory(snapshot)) return { status: "unknown", text: UNKNOWN_TEXT };
  return idleReading(newestFor(events, role));
}

function developerCard(snapshot: OfficeSnapshot, events: readonly PlaybackEvent[]): DeveloperCard {
  const seatInfo = SEATS.map((seat) => seatReading(seat, snapshot));
  const seats = seatInfo.map((info) => info.reading);
  const executions = snapshot.executions ?? [];
  const annex = executions.filter((execution) => execution.role === "developer" && execution.assignment?.station === "annex" && isRunning(execution)).length;
  const unassigned = executions.filter((execution) => execution.role === "developer" && isRunning(execution)
    && (execution.assignment === null || (execution.assignment.station === "developer" && execution.assignment.seat === null))).length;
  // A developer wait is shown on a seat when that seat owns it; any other developer wait goes on the card.
  const claimed = new Set(seatInfo.flatMap((info) => (info.claimed === null ? [] : [info.claimed])));
  const developerWaits = (snapshot.tasks ?? []).filter((task) => task.role === "developer" && task.state === "waiting");
  const unclaimed = developerWaits.find((task) => !claimed.has(task.ref));
  const working = seats.some((seat) => seat.status === "working") || annex > 0 || unassigned > 0;
  const waiting = seats.some((seat) => seat.status === "waiting") || developerWaits.length > 0;
  const status: Status = working ? "working" : waiting ? "waiting" : unknownInventory(snapshot) ? "unknown" : "idle";
  return {
    status,
    seats,
    annex,
    unassigned,
    waiting: unclaimed ? waitingLabel(unclaimed) : null,
    lastEventAt: newestFor(events, "developer")?.recorded_at ?? null,
  };
}

/** A seat is waiting only when a waiting task is tied to one of that seat's executions. An idle seat shows only its state word. */
function seatReading(seat: Seat, snapshot: OfficeSnapshot): { reading: SeatReading; claimed: TaskRef | null } {
  const runs = (snapshot.executions ?? []).filter((execution) => execution.role === "developer" && execution.assignment?.station === "developer" && execution.assignment.seat === seat);
  const working = runs.find(isRunning);
  if (working) return { reading: { seat, status: "working", text: executionText(snapshot, working) }, claimed: null };
  const refs = new Set(runs.map((execution) => execution.ref));
  const waiting = (snapshot.tasks ?? []).find((task) => task.state === "waiting" && task.execution_ref !== null && refs.has(task.execution_ref));
  if (waiting) return { reading: { seat, status: "waiting", text: waitingText(waiting) }, claimed: waiting.ref };
  if (unknownInventory(snapshot)) return { reading: { seat, status: "unknown", text: UNKNOWN_TEXT }, claimed: null };
  return { reading: { seat, status: "idle", text: "" }, claimed: null };
}

function idleReading(last: OfficeEvent | null): Reading {
  return { status: "idle", text: last ? `Last: ${eventText(last)}` : "No recent activity" };
}

function waitingLabel(task: OfficeTask): string {
  return task.waiting_on ? `Waiting on ${WAITING_ON[task.waiting_on]}` : "Waiting";
}

/** "Waiting on Developer: <task>". The task text follows the label. */
function waitingText(task: OfficeTask): string {
  return `${waitingLabel(task)}: ${taskText(task)}`;
}

function taskText(task: OfficeTask | undefined): string {
  if (!task) return "Task details unavailable";
  return task.visibility === "private" ? "Private task" : task.description;
}

function executionText(snapshot: OfficeSnapshot, execution: OfficeExecution): string {
  if (execution.task_ref === null) return "No task reported";
  return taskText((snapshot.tasks ?? []).find((task) => task.ref === execution.task_ref));
}

function eventText(event: OfficeEvent): string {
  return event.visibility === "private" ? "Private task" : event.description;
}

/** The newest recorded event for a role. Withdrawn tombstones carry no role and are skipped. */
function newestFor(events: readonly PlaybackEvent[], role: OfficeRole): OfficeEvent | null {
  let best: OfficeEvent | null = null;
  for (const event of events) {
    if ("deleted" in event || event.role !== role) continue;
    if (best === null || compareOfficePositions(event.position, best.position) > 0) best = event;
  }
  return best;
}
