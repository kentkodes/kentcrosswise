import { describe, expect, it } from "vitest";
import type { AvailableOffice, ExecutionRef, OfficeEvent, OfficeExecution, TaskRef } from "../src/office-contract";
import { parseOfficeEnvelope } from "../src/office-contract";
import { OfficePlayback, type PlaybackEvent, type PlaybackView } from "../src/office-playback";
import { ACTIVITY_FILTERS, ACTIVITY_LIMIT, RESTART_MIN_MS, deriveBoard, filterRows, loadingBoard, relativeTime, shouldRestart, utcLabel, viewKey } from "../src/app/(public)/office/board/board-state";
import { bootstrapFixture, officeFixture, REFS } from "./fixtures/office-contract";

const now = { wallMs: Date.parse("2026-10-25T18:30:00.000Z"), monoMs: 0 };
const recordedAt = "2026-10-25T18:20:00.000Z";
const liveAt = "2026-10-25T18:21:00.000Z";
const GENERATION_2 = "gen_11111111-1111-4111-8111-111111111111";

function playback() {
  const p = new OfficePlayback();
  p.receive(p.request("bootstrap", now)!, bootstrapFixture(), now);
  return p;
}
/** A fresh view of the bootstrap fixture. The view is a copy, so tests may change it freely. */
const viewOf = (): PlaybackView => playback().view(now);
const rosterOf = (view: PlaybackView) => deriveBoard(view).roster;
const execution = (ref: string, phase: OfficeExecution["phase"], outcome: OfficeExecution["outcome"], source: NonNullable<OfficeExecution["observation"]>["source"], station: "annex" | "developer", seat: number): OfficeExecution => ({
  ref: ref as ExecutionRef, task_ref: null, role: "developer", assignment: { station, seat }, phase, outcome,
  observation: { source, observed_at: recordedAt }, reported_activity: null, reported_at: null,
});
/** A running developer execution with no seat: assignment null, or station developer with seat null, or an annex seat null. */
const unseated = (ref: string, station: "developer" | "annex" | null, seat: number | null): OfficeExecution => ({
  ref: ref as ExecutionRef, task_ref: null, role: "developer", assignment: station === null ? null : { station, seat }, phase: "running", outcome: null,
  observation: { source: "trusted_work_job", observed_at: recordedAt }, reported_activity: null, reported_at: null,
});
/** A live (received, not replayed) public QA event, newer than every fixture event. */
const liveEvent = (i: number, text = `Check ${i}`): PlaybackEvent => ({
  ref: `event_57e6faff-6aa4-4498-ae97-${String(i).padStart(12, "0")}`, position: { revision: String(100 + i), ordinal: 0 },
  recorded_at: liveAt, role: "qa", type: "ci_running", task_ref: null, execution_ref: null, visibility: "public", description: text,
} as OfficeEvent);
/** A state envelope from another generation: the playback records a restart gap for it. */
function otherGeneration(): AvailableOffice {
  const e = bootstrapFixture();
  return { ...e, generation: GENERATION_2, events: [], history: { ...e.history, mode: "state", generation: GENERATION_2, from: null, through: null, cursor: null, replay: null, has_more: false, completeness: "complete" } };
}

describe("team board: cards always render", () => {
  it("renders all five cards and four seats while loading, with grey 'Loading…' cards", () => {
    const board = deriveBoard(new OfficePlayback().view(now));
    const roster = board.roster;
    for (const card of [roster.orchestrator, roster.qa, roster.docs, roster.scraper]) {
      expect(card).toMatchObject({ status: "unknown", text: "Loading…", lastEventAt: null });
    }
    expect(roster.developer.status).toBe("unknown");
    expect(roster.developer.seats).toHaveLength(4);
    for (const seat of roster.developer.seats) expect(seat).toMatchObject({ status: "unknown", text: "Loading…" });
    expect(board.activity.state).toBe("loading");
    expect(loadingBoard()).toEqual(board);
  });

  it("shows 'Status unavailable' on every card when the feed fails before any snapshot", () => {
    const p = new OfficePlayback();
    p.fail(p.request("bootstrap", now)!);
    const board = deriveBoard(p.view(now));
    const roster = board.roster;
    for (const card of [roster.orchestrator, roster.qa, roster.docs, roster.scraper]) expect(card).toMatchObject({ status: "unknown", text: "Status unavailable" });
    for (const seat of roster.developer.seats) expect(seat).toMatchObject({ status: "unknown", text: "Status unavailable" });
    expect(board.pills.feed).toEqual({ tone: "warn", label: "Feed unavailable" });
    expect(board.activity.state).toBe("unavailable");
  });
});

describe("team board: role cards", () => {
  it("shows orchestrator and scraper as idle with no recent activity when nothing is recorded for them", () => {
    const view = viewOf();
    view.replay.events = [];
    const roster = rosterOf(view);
    for (const card of [roster.orchestrator, roster.scraper]) {
      expect(card).toEqual({ status: "idle", text: "No recent activity", lastEventAt: null });
    }
  });

  it("marks a card working from a starting or running execution, even when a waiting task exists", () => {
    // Fixture: docs has a running execution on a private task and a waiting public task.
    const docs = rosterOf(viewOf()).docs;
    expect(docs).toEqual({ status: "working", text: "Private task", lastEventAt: recordedAt });
  });

  it("does not treat a terminal execution as working; the last public event is the idle line", () => {
    const qa = rosterOf(viewOf()).qa;
    expect(qa).toEqual({ status: "idle", text: "Last: Add a health endpoint", lastEventAt: recordedAt });
  });

  it("shows a waiting task as 'Waiting on <owner>: <public title>', and maps each waiting_on value", () => {
    const cases: [string, string][] = [["dev", "Waiting on Developer"], ["ci", "Waiting on CI"], ["qa", "Waiting on QA"], ["owner", "Waiting on owner"], ["deploy", "Waiting on deploy"]];
    for (const [waitingOn, label] of cases) {
      const view = viewOf();
      view.current!.snapshot.executions = [];
      const docs = view.current!.snapshot.tasks!.find((task) => task.ref === REFS.docs)!;
      docs.waiting_on = waitingOn as typeof docs.waiting_on;
      expect(rosterOf(view).docs).toEqual({ status: "waiting", text: `${label}: Document the health endpoint`, lastEventAt: recordedAt });
    }
  });

  it("derives 'Private task' for a private task whatever its stored description", () => {
    const view = viewOf();
    view.current!.snapshot.executions = [];
    const docs = view.current!.snapshot.tasks!.find((task) => task.ref === REFS.docs)!;
    // Only the visibility is set: the title stays a real title, so the assertion depends on the derivation.
    docs.visibility = "private";
    docs.description = "Secret title";
    expect(rosterOf(view).docs).toMatchObject({ status: "waiting", text: "Waiting on Developer: Private task" });
    expect(JSON.stringify(deriveBoard(view))).not.toContain("Secret title");
  });

  it("the contract parser refuses a private task with a title, so no title reaches the board", () => {
    const e = bootstrapFixture();
    e.snapshot.tasks![1]!.description = "Secret title";
    expect(parseOfficeEnvelope(e)).toEqual({ ok: false, code: "privacy" });
  });

  it("cards read the combined events, so a newer live event sets the Last line", () => {
    const view = viewOf();
    view.log = [liveEvent(1)];
    expect(rosterOf(view).qa).toEqual({ status: "idle", text: "Last: Check 1", lastEventAt: liveAt });
  });
});

describe("team board: developer seats and annex", () => {
  it("shows every idle seat as just 'Idle' with no text line; the developer footer keeps its last event", () => {
    const developer = rosterOf(viewOf()).developer;
    expect(developer.status).toBe("idle");
    expect(developer.annex).toBe(0);
    expect(developer.unassigned).toBe(0);
    expect(developer.waiting).toBeNull();
    expect(developer.seats.map((seat) => seat.seat)).toEqual([1, 2, 3, 4]);
    for (const seat of developer.seats) expect(seat).toEqual({ seat: seat.seat, status: "idle", text: "" });
    expect(developer.lastEventAt).toBe(recordedAt);
  });

  it("shows a seat waiting only when a waiting task is tied to that seat's execution, and then not on the card", () => {
    const view = viewOf();
    const privateOne = view.current!.snapshot.tasks!.find((task) => task.ref === REFS.privateOne)!;
    privateOne.state = "waiting";
    privateOne.waiting_on = "ci";
    const developer = rosterOf(view).developer;
    expect(developer.status).toBe("waiting");
    expect(developer.seats[0]).toEqual({ seat: 1, status: "waiting", text: "Waiting on CI: Private task" });
    expect(developer.seats[1]).toEqual({ seat: 2, status: "idle", text: "" });
    expect(developer.waiting).toBeNull();
  });

  it("shows an unclaimed developer wait on the Developer card, under the header, when no seat shows it", () => {
    const view = viewOf();
    view.current!.snapshot.tasks!.push({
      ref: "task_0a1b2c3d-0000-4000-8000-000000000001" as TaskRef, visibility: "public", description: "Fix the parser", kind: "work",
      state: "waiting", waiting_on: "ci", paused: false, role: "developer", execution_ref: null,
    });
    const developer = rosterOf(view).developer;
    expect(developer.waiting).toBe("Waiting on CI");
    expect(developer.status).toBe("waiting");
    expect(developer.seats.every((seat) => seat.status === "idle")).toBe(true);
  });

  it("counts running and starting annex executions only, and marks the developer card working", () => {
    const view = viewOf();
    view.current!.snapshot.executions!.push(
      execution("exec_annex-running", "running", null, "trusted_work_job", "annex", 1),
      execution("exec_annex-starting", "starting", null, "trusted_start_report", "annex", 2),
      execution("exec_annex-done", "terminal", "succeeded", "trusted_workflow", "annex", 3),
    );
    const developer = rosterOf(view).developer;
    expect(developer.annex).toBe(2);
    expect(developer.status).toBe("working");
  });

  it("marks a seat working from its running execution and shows the private task text", () => {
    const view = viewOf();
    const seat = view.current!.snapshot.executions!.find((run) => run.ref === REFS.privateOneRun)!;
    seat.phase = "running";
    seat.observation = { source: "trusted_work_job", observed_at: recordedAt };
    const developer = rosterOf(view).developer;
    expect(developer.seats[0]).toEqual({ seat: 1, status: "working", text: "Private task" });
    expect(developer.status).toBe("working");
  });

  it("counts a running execution with no assignment as unassigned, not as a seat or annex worker", () => {
    const view = viewOf();
    view.current!.snapshot.executions!.push(unseated("exec_unseated-null", null, null));
    const developer = rosterOf(view).developer;
    expect(developer.unassigned).toBe(1);
    expect(developer.annex).toBe(0);
    expect(developer.seats.every((seat) => seat.status === "idle")).toBe(true);
    expect(developer.status).toBe("working");
    expect(deriveBoard(view).pills.system).toEqual({ tone: "ok", label: "Working" });
  });

  it("counts a station-developer execution with seat null as unassigned, and pluralises the count", () => {
    const view = viewOf();
    view.current!.snapshot.executions!.push(unseated("exec_unseated-seatnull", "developer", null));
    expect(rosterOf(view).developer.unassigned).toBe(1);
    view.current!.snapshot.executions!.push(unseated("exec_unseated-two", null, null));
    expect(rosterOf(view).developer.unassigned).toBe(2);
  });

  it("leaves an annex execution with no seat in the annex count, not the unassigned count", () => {
    const view = viewOf();
    view.current!.snapshot.executions!.push(unseated("exec_annex-noseat", "annex", null));
    const developer = rosterOf(view).developer;
    expect(developer.annex).toBe(1);
    expect(developer.unassigned).toBe(0);
  });
});

describe("team board: null inventories are unknown, not idle", () => {
  it("shows cards and seats as unknown when the execution inventory is withheld, but keeps a confirmed wait", () => {
    const view = viewOf();
    view.current!.snapshot.executions = null;
    const roster = rosterOf(view);
    expect(roster.qa).toEqual({ status: "unknown", text: "Status unavailable", lastEventAt: recordedAt });
    expect(roster.orchestrator).toMatchObject({ status: "unknown", text: "Status unavailable" });
    expect(roster.developer.seats.every((seat) => seat.status === "unknown")).toBe(true);
    expect(roster.developer.status).toBe("unknown");
    // The docs wait is in the task inventory, which is present, so it still shows.
    expect(roster.docs).toMatchObject({ status: "waiting", text: "Waiting on Developer: Document the health endpoint" });
  });

  it("skips the waiting check and shows unknown cards when the task inventory is withheld", () => {
    const view = viewOf();
    view.current!.snapshot.tasks = null;
    const board = deriveBoard(view);
    // qa has no running execution, and without tasks its waiting state cannot be checked.
    expect(board.roster.qa).toMatchObject({ status: "unknown", text: "Status unavailable" });
    // docs still has a running execution, which needs no task list for its status. Its task text cannot be resolved.
    expect(board.roster.docs).toMatchObject({ status: "working", text: "Task details unavailable" });
    expect(board.roster.developer.seats[0]).toEqual({ seat: 1, status: "unknown", text: "Status unavailable" });
    expect(board.roster.developer.status).toBe("unknown");
    expect(board.pills.inFlight).toBeNull();
  });

  it("agrees with the cards: no Idle pill while the task inventory is withheld", () => {
    const view = viewOf();
    view.current!.snapshot.executions = [view.current!.snapshot.executions![0]!];
    view.current!.snapshot.tasks = null;
    expect(deriveBoard(view).pills.system).toBeNull();
  });
});

describe("team board: status pills", () => {
  it("shows Working and the in-flight count from the confirmed snapshot", () => {
    const pills = deriveBoard(viewOf()).pills;
    expect(pills).toEqual({ system: { tone: "ok", label: "Working" }, inFlight: 2, feed: null });
  });

  it("shows Paused when the system is paused, even while something runs", () => {
    const view = viewOf();
    view.current!.snapshot.pause.paused = true;
    expect(deriveBoard(view).pills.system).toEqual({ tone: "warn", label: "Paused" });
  });

  it("shows Idle when nothing runs and the execution inventory is present", () => {
    const view = viewOf();
    view.current!.snapshot.executions = [view.current!.snapshot.executions![0]!];
    expect(deriveBoard(view).pills.system).toEqual({ tone: "idle", label: "Idle" });
  });

  it("shows no system pill when the execution inventory is withheld", () => {
    const view = viewOf();
    view.current!.snapshot.executions = null;
    expect(deriveBoard(view).pills.system).toBeNull();
  });

  it("reports delayed updates after 30 s without a new observation, and an unavailable feed", () => {
    const p = playback();
    expect(deriveBoard(p.view({ wallMs: now.wallMs + 31_000, monoMs: 31_000 })).pills.feed).toEqual({ tone: "warn", label: "Updates delayed" });
    p.fail(p.request("state", now)!);
    const unavailable = deriveBoard(p.view(now));
    expect(unavailable.pills.feed).toEqual({ tone: "warn", label: "Feed unavailable" });
  });
});

describe("team board: activity list", () => {
  it("lists replay events newest first, titled replay, while no live event has been received", () => {
    const board = deriveBoard(viewOf());
    expect(board.activity.replay).toBe(true);
    expect(board.activity.state).toBe("list");
    const rows = board.activity.rows;
    expect(rows[0]).toEqual({ key: rows[0]!.key, kind: "event", recordedAt, role: "qa", roleLabel: "QA", label: "Merged", text: "Add a health endpoint" });
    expect(rows[1]).toMatchObject({ kind: "event", role: "docs", roleLabel: "Docs-keeper", label: "Coding reported", text: "Private task" });
    expect(rows).toHaveLength(3);
  });

  it("merges live and replay events once per ref, withdrawn rows under All only, and filters by role", () => {
    const view = viewOf();
    const privateOne = view.replay.events.find((event) => event.ref === officeFixture().events[0]!.ref)!;
    const tombstone: PlaybackEvent = { ref: "event_57e6faff-6aa4-4498-ae97-000000000099", position: { revision: "10", ordinal: 5 }, deleted: true };
    view.log = [privateOne, tombstone];
    const board = deriveBoard(view);
    expect(board.activity.replay).toBe(false);
    // privateOne is in both the log and the replay, and appears once; the three replay-only events add two more rows.
    expect(board.activity.rows).toHaveLength(4);
    expect(filterRows(board.activity.rows, "all").map((row) => row.kind)).toEqual(["withdrawn", "event", "event", "event"]);
    expect(filterRows(board.activity.rows, "developer")).toEqual([
      { key: privateOne.ref, kind: "event", recordedAt, role: "developer", roleLabel: "Developer", label: "Coding reported", text: "Private task" },
    ]);
    expect(filterRows(board.activity.rows, "orchestrator")).toEqual([]);
  });

  it("shows a withdrawn event on the Board as a withdrawn row, with no role or text", () => {
    const view = viewOf();
    const tombstone: PlaybackEvent = { ref: "event_57e6faff-6aa4-4498-ae97-000000000099", position: { revision: "10", ordinal: 5 }, deleted: true };
    view.log = [tombstone];
    const rows = deriveBoard(view).activity.rows;
    expect(rows[0]).toEqual({ key: tombstone.ref, kind: "withdrawn" });
    expect(filterRows(rows, "all")[0]).toEqual({ key: tombstone.ref, kind: "withdrawn" });
  });

  it("caps the list at 50 newest rows, with live events ahead of older replay events", () => {
    const view = viewOf();
    view.log = Array.from({ length: 60 }, (_, i) => liveEvent(i));
    const board = deriveBoard(view);
    expect(ACTIVITY_LIMIT).toBe(50);
    const rows = filterRows(board.activity.rows, "all");
    expect(rows).toHaveLength(50);
    expect(rows[0]).toMatchObject({ text: "Check 59" });
    expect(rows[49]).toMatchObject({ text: "Check 10" });
    expect(board.activity.replay).toBe(false);
  });

  it("applies the role filter before the 50-row cap, so a quiet role still shows its older events", () => {
    const view = viewOf();
    // Sixty newer QA events push the one developer event (replayed, older) past the 50-row window.
    view.log = Array.from({ length: 60 }, (_, i) => liveEvent(i));
    const board = deriveBoard(view);
    expect(board.activity.rows).toHaveLength(63);
    const developerRows = filterRows(board.activity.rows, "developer");
    expect(developerRows).toEqual([
      { key: officeFixture().events[0]!.ref, kind: "event", recordedAt, role: "developer", roleLabel: "Developer", label: "Coding reported", text: "Private task" },
    ]);
    expect(filterRows(board.activity.rows, "docs")).toHaveLength(1);
    expect(filterRows(board.activity.rows, "qa")).toHaveLength(50);
  });

  it("shows the empty state when there is no recorded activity", () => {
    const view = viewOf();
    view.replay.events = [];
    const board = deriveBoard(view);
    expect(board.activity).toEqual({ state: "empty", replay: false, stale: false, rows: [] });
    expect(board.roster.qa.status).toBe("idle");
  });

  it("offers All plus five role filters in order", () => {
    expect(ACTIVITY_FILTERS.map((option) => option.label)).toEqual(["All", "Orchestrator", "Developer", "QA", "Docs", "Scraper"]);
  });
});

describe("team board: unavailable feed keeps the last state", () => {
  it("keeps the last snapshot, cards and rows when the feed becomes unavailable, and marks them stale", () => {
    const p = playback();
    p.fail(p.request("state", now)!);
    const board = deriveBoard(p.view(now));
    expect(board.pills.feed).toEqual({ tone: "warn", label: "Feed unavailable" });
    expect(board.roster.qa).toEqual({ status: "idle", text: "Last: Add a health endpoint", lastEventAt: recordedAt });
    expect(board.roster.docs.status).toBe("working");
    expect(board.activity).toMatchObject({ state: "list", stale: true });
    expect(board.activity.rows).toHaveLength(3);
  });

  it("shows the unavailable message only when there are no rows at all", () => {
    const view = viewOf();
    view.availability = "unavailable";
    view.log = [];
    view.replay.events = [];
    expect(deriveBoard(view).activity).toEqual({ state: "unavailable", replay: false, stale: false, rows: [] });
  });

  it("is not stale while the feed is healthy", () => {
    expect(deriveBoard(viewOf()).activity.stale).toBe(false);
  });
});

describe("team board: restart gap recovery", () => {
  it("a generation change leaves the playback unable to fetch incrementally, so the board must start a fresh one", () => {
    const p = playback();
    expect(p.receive(p.request("state", now)!, otherGeneration(), now)).toBe("gap");
    expect(p.view(now).gap).toMatchObject({ reason: "generation_changed", recovery: "restart" });
    expect(p.request("incremental", now)).toBeNull();
  });

  it("a fresh playback bootstraps after the restart, and the board recovers its rows", () => {
    const fresh = new OfficePlayback();
    expect(fresh.receive(fresh.request("bootstrap", now)!, bootstrapFixture(), now)).toBe("accepted");
    expect(deriveBoard(fresh.view(now)).activity.rows).toHaveLength(3);
  });

  it("restarts a restart-gap playback once, then waits 30 s before another restart", () => {
    const p = playback();
    p.receive(p.request("state", now)!, otherGeneration(), now);
    const stuck = p.view(now);
    expect(shouldRestart(stuck, -Infinity, 0)).toBe(true);
    // The restart happened at monotonic time 0: a stuck view one second later must not restart again.
    expect(shouldRestart(stuck, 0, 1_000)).toBe(false);
    expect(shouldRestart(stuck, 0, RESTART_MIN_MS - 1)).toBe(false);
    expect(shouldRestart(stuck, 0, RESTART_MIN_MS)).toBe(true);
  });

  it("does not restart without a restart gap, or for a rebind gap", () => {
    expect(shouldRestart(viewOf(), -Infinity, 0)).toBe(false);
    const rebind = viewOf();
    rebind.gap = { reason: "cursor_unavailable", from: null, through: null, recovery: "rebind" };
    expect(shouldRestart(rebind, -Infinity, 0)).toBe(false);
  });

  it("the view key changes when the board shows something new, and not otherwise", () => {
    const view = viewOf();
    const base = viewKey(view);
    expect(viewKey(view)).toBe(base);
    view.log = [liveEvent(1)];
    expect(viewKey(view)).not.toBe(base);
  });
});

describe("team board: privacy", () => {
  it("never shows a private task's description anywhere in the derived board", () => {
    const view = viewOf();
    const secret = "Secret title";
    for (const task of view.current!.snapshot.tasks!) if (task.visibility === "private") task.description = secret;
    for (const event of view.replay.events) if (!("deleted" in event) && event.visibility === "private") event.description = secret;
    const board = deriveBoard(view);
    expect(JSON.stringify(board)).not.toContain(secret);
  });
});

describe("team board: times", () => {
  it("formats the absolute UTC label from the ISO string", () => {
    expect(utcLabel("2026-11-11T15:42:00.000Z")).toBe("Nov 11, 15:42 UTC");
    expect(utcLabel("2026-01-05T07:03:00.000Z")).toBe("Jan 5, 07:03 UTC");
  });

  it("formats relative times in coarse steps, and treats future timestamps as just now", () => {
    const at = "2026-11-11T15:42:00.000Z";
    const from = (ms: number) => relativeTime(at, Date.parse(at) + ms);
    expect(from(30_000)).toBe("just now");
    expect(from(5 * 60_000)).toBe("5 min ago");
    expect(from(3 * 3_600_000)).toBe("3 h ago");
    expect(from(50 * 3_600_000)).toBe("2 d ago");
    expect(from(-60_000)).toBe("just now");
  });
});
