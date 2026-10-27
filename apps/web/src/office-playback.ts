// Local deterministic client unit. No transport, timers, persistence or room imports.
import { compareOfficePositions, parseOfficeEnvelope, type AvailableOffice, type OfficeEvent, type OfficeGap, type OfficePosition, type OfficeSnapshot, type TaskRef } from "./office-contract";

export const OFFICE_PLAYBACK = { capacity: 256, page: 50, pollMs: 5000, staleMs: 30000 } as const;
export type PlaybackEvent = OfficeEvent | { ref: OfficeEvent["ref"]; position: OfficePosition; deleted: true };
export interface OfficeClock { wallMs: number; monoMs: number }
export interface PlaybackRequest {
  id: number; session: number; mode: "bootstrap" | "state" | "incremental";
  generation: string | null; epoch: string | null; cursor: string | null;
  after: OfficePosition | null; rebind: boolean; started: OfficeClock;
}
export interface PlaybackView {
  generation: string | null; epoch: string | null;
  current: { revision: string; snapshot: OfficeSnapshot; capabilities: AvailableOffice["capabilities"]; observedAt: string } | null;
  received: OfficePosition | null; illustrated: OfficePosition | null; cursor: string | null;
  pending: PlaybackEvent[]; active: PlaybackEvent | null; log: PlaybackEvent[];
  replay: { events: PlaybackEvent[]; index: number; illustrated: OfficePosition | null; completeness: "complete" | "partial" | "unknown" };
  mode: "live" | "replay" | "fictional"; paused: boolean;
  gap: OfficeGap | null; rebind: boolean; history: "partial" | "initialized";
  availability: "unknown" | "available" | "unavailable";
  freshness: "unknown" | "fresh" | "stale" | "unavailable";
}
const same = (a: OfficePosition | null, b: OfficePosition | null) => a === null || b === null ? a === b : compareOfficePositions(a, b) === 0;
const copy = <T>(v: T): T => structuredClone(v);
const deleted = (e: PlaybackEvent): e is Extract<PlaybackEvent, { deleted: true }> => "deleted" in e;

/** One active transition globally serializes shared visual resources. Only finish()
 * advances illustration; elapsed time, polling and snapshots never complete it.
 * Renderers must refresh all retained labels when view().epoch changes. */
export class OfficePlayback {
  private state: PlaybackView = {
    generation: null, epoch: null, current: null, received: null, illustrated: null, cursor: null,
    pending: [], active: null, log: [], replay: { events: [], index: 0, illustrated: null, completeness: "unknown" },
    mode: "live", paused: false, gap: null, rebind: false, history: "partial", availability: "unknown", freshness: "unknown",
  };
  private session = 0;
  private requestId = 0;
  private lastObservation = -Infinity;
  private freshAt: { mono: number; age: number } | null = null;
  private lastPoll = -Infinity;
  private activeMode: "live" | "replay" | null = null;
  private lastResponseId = 0;

  view(now: OfficeClock): PlaybackView {
    const value = copy(this.state);
    value.freshness = !Number.isFinite(now.monoMs) || !Number.isFinite(now.wallMs) ? "unknown" : value.availability === "unavailable" ? "unavailable" : this.freshAt === null ? "unknown"
      : now.monoMs < this.freshAt.mono || this.freshAt.age + now.monoMs - this.freshAt.mono >= OFFICE_PLAYBACK.staleMs ? "stale" : "fresh";
    return value;
  }
  pollDue(now: OfficeClock): boolean { return now.monoMs - this.lastPoll >= OFFICE_PLAYBACK.pollMs; }
  request(mode: PlaybackRequest["mode"], now: OfficeClock): PlaybackRequest | null {
    const s = this.state;
    if (mode === "bootstrap" && s.history === "initialized") return null;
    if (mode === "incremental" && s.history !== "initialized") return null;
    if (mode === "incremental" && (!s.cursor || s.gap?.recovery === "restart" || s.pending.length + Number(s.active !== null) + OFFICE_PLAYBACK.page > OFFICE_PLAYBACK.capacity)) return null;
    if (mode === "state") this.lastPoll = now.monoMs;
    return { id: ++this.requestId, session: this.session, mode, generation: s.generation, epoch: s.epoch, cursor: s.cursor, after: copy(s.received), rebind: s.rebind, started: copy(now) };
  }
  fail(request: PlaybackRequest): void {
    if (request.session === this.session && request.id >= this.lastResponseId) {
      this.state.availability = "unavailable"; this.lastResponseId = request.id;
    }
  }
  receive(request: PlaybackRequest, input: unknown, now: OfficeClock): "accepted" | "ignored" | "invalid" | "capacity" | "gap" {
    if (request.session !== this.session) return "ignored";
    const parsed = parseOfficeEnvelope(input);
    if (!parsed.ok) { this.fail(request); return "invalid"; }
    const e = parsed.value;
    if (!e.available) { this.fail(request); return "accepted"; }
    const s = this.state;
    if (s.gap?.reason === "generation_changed") return "ignored";
    if (e.history.mode !== request.mode) return "invalid";
    if (s.generation !== null && request.generation !== s.generation && !(request.mode === "bootstrap" && s.history === "partial")) return "ignored";
    if (s.generation !== null && e.generation !== s.generation) {
      this.withdrawAll();
      s.gap = { reason: "generation_changed", from: copy(s.received), through: null, recovery: "restart" };
      s.availability = "unavailable";
      return "gap";
    }
    if (s.epoch !== null && BigInt(e.privacy_epoch) < BigInt(s.epoch)) return "ignored";
    const epochChanged = s.epoch !== null && BigInt(e.privacy_epoch) > BigInt(s.epoch);
    if (epochChanged && (e.history.invalidations.length === 0 || e.history.gap?.recovery === "restart")) this.withdrawAll();
    this.invalidate(e);
    s.generation = e.generation;
    s.epoch = e.privacy_epoch;
    if (epochChanged && !e.history.gap && e.history.invalidations.length === 0) {
      s.gap = { reason: "privacy_changed", from: copy(s.received), through: null, recovery: "restart" };
      return "gap";
    }
    const newerState = s.current === null || BigInt(e.revision) >= BigInt(s.current.revision);
    if (newerState && Date.parse(e.observed_at) >= this.lastObservation) {
      s.current = { revision: e.revision, snapshot: copy(e.snapshot), capabilities: copy(e.capabilities), observedAt: e.observed_at };
      this.observe(e, request, now);
    }
    if (request.id >= this.lastResponseId) {
      s.availability = "available"; this.lastResponseId = request.id;
    }
    if (e.history.gap) {
      if (s.gap?.recovery !== "restart") s.gap = copy(e.history.gap);
      s.rebind = s.gap?.recovery === "rebind";
      return "gap";
    }
    if (request.mode === "state") return "accepted";
    if (request.mode === "bootstrap") {
      if (s.history === "initialized") return "ignored";
      s.received = copy(e.history.through); s.cursor = e.history.cursor;
      const replay = e.history.replay;
      s.replay = { events: copy(replay?.events ?? []), index: 0, illustrated: null, completeness: replay?.completeness ?? "unknown" };
      s.history = "initialized";
      return "accepted";
    }
    if (s.gap?.recovery === "restart") return "gap";
    if (request.cursor !== s.cursor || !same(request.after, s.received) || !same(e.history.from, s.received)) return "ignored";
    const identities = new Map([...s.log, ...s.pending, ...s.replay.events, ...(s.active ? [s.active] : [])].map((event) => [event.ref, event.position]));
    if (e.events.some((event) => identities.has(event.ref) && !same(identities.get(event.ref)!, event.position))) return "invalid";
    const events = e.events.filter((event) => !identities.has(event.ref));
    if (s.pending.length + Number(s.active !== null) + events.length > OFFICE_PLAYBACK.capacity) return "capacity";
    s.pending.push(...copy(events));
    s.received = copy(e.history.through); s.cursor = e.history.cursor;
    s.gap = null; s.rebind = false;
    if (events.length && s.mode === "replay") {
      // Switch the entire scene atomically; replay restarts its interrupted beat.
      s.active = null; this.activeMode = null; s.mode = "live";
    }
    return "accepted";
  }
  setPaused(paused: boolean): void { this.state.paused = paused; }
  setMode(mode: PlaybackView["mode"]): boolean {
    if (this.state.active !== null || mode === "replay" && this.state.pending.length > 0) return false;
    this.state.mode = mode; return true;
  }
  /** Begin another historical loop without resetting live truth or delivery. */
  rewindReplay(): boolean {
    const s = this.state;
    if (s.mode !== "replay" || s.active !== null || s.pending.length > 0) return false;
    s.replay.index = 0; s.replay.illustrated = null;
    return true;
  }
  begin(): PlaybackEvent | null {
    const s = this.state;
    if (s.paused || s.mode === "fictional" || s.active) return null;
    const event = s.mode === "live" ? s.pending.shift() : s.replay.events[s.replay.index];
    if (!event) return null;
    this.activeMode = s.mode;
    s.active = copy(event); return copy(event);
  }
  finish(ref: PlaybackEvent["ref"]): boolean {
    const s = this.state;
    if (s.paused || !s.active || s.active.ref !== ref) return false;
    if (this.activeMode === "replay") { s.replay.illustrated = copy(s.active.position); s.replay.index++; }
    else { s.illustrated = copy(s.active.position); s.log.push(copy(s.active)); }
    s.active = null; this.activeMode = null; return true;
  }
  /** Explicit whole-scene recovery. Outstanding responses become invalid. Reload
   * and restart report partial history rather than claiming persisted continuity. */
  restart(): void {
    const fresh = new OfficePlayback();
    this.state = fresh.state; this.session++; this.lastObservation = -Infinity;
    this.freshAt = null; this.lastPoll = -Infinity; this.activeMode = null; this.lastResponseId = 0;
  }
  private observe(e: AvailableOffice, request: PlaybackRequest, now: OfficeClock): void {
    const observed = Date.parse(e.observed_at);
    const elapsed = now.monoMs - request.started.monoMs;
    if (![now.wallMs, now.monoMs, request.started.wallMs, request.started.monoMs, observed].every(Number.isFinite)
      || elapsed < 0 || now.wallMs < request.started.wallMs || observed > now.wallMs) { this.freshAt = null; return; }
    if (observed <= this.lastObservation) return;
    this.lastObservation = observed;
    this.freshAt = { mono: now.monoMs, age: Math.max(now.wallMs - observed, elapsed) };
  }
  private withdrawAll(): void {
    const s = this.state;
    const tombstone = (e: PlaybackEvent): PlaybackEvent => ({ ref: e.ref, position: copy(e.position), deleted: true });
    s.pending = s.pending.map(tombstone); s.log = s.log.map(tombstone); s.replay.events = s.replay.events.map(tombstone);
    if (s.active) s.active = tombstone(s.active);
    s.current = null;
  }
  private invalidate(e: AvailableOffice): void {
    const s = this.state;
    for (const invalidation of e.history.invalidations) {
      const ref = invalidation.task_ref;
      const label = e.snapshot.tasks?.find((t) => t.ref === ref);
      const rewrite = (event: PlaybackEvent): PlaybackEvent => {
        if (deleted(event) || event.task_ref !== ref) return event;
        if (invalidation.kind === "delete") return { ref: event.ref, position: copy(event.position), deleted: true };
        return { ...event, visibility: label?.visibility ?? "private", description: label?.description ?? "Private task" };
      };
      s.pending = s.pending.map(rewrite); s.log = s.log.map(rewrite); s.replay.events = s.replay.events.map(rewrite);
      if (s.active) s.active = rewrite(s.active);
      if (s.current) this.invalidateSnapshot(s.current.snapshot, ref, invalidation.kind, label);
    }
  }
  private invalidateSnapshot(snapshot: OfficeSnapshot, ref: TaskRef, kind: "redact" | "relabel" | "delete", label: NonNullable<OfficeSnapshot["tasks"]>[number] | undefined): void {
    if (kind === "delete") {
      snapshot.tasks = snapshot.tasks?.filter((t) => t.ref !== ref) ?? null;
      snapshot.executions = snapshot.executions?.filter((x) => x.task_ref !== ref) ?? null;
      snapshot.related_tasks = snapshot.related_tasks?.filter((r) => r.task_ref !== ref && r.related_task_ref !== ref) ?? null;
    } else {
      const safe = { visibility: label?.visibility ?? "private" as const, description: label?.description ?? "Private task" };
      snapshot.tasks = snapshot.tasks?.map((t) => t.ref === ref ? { ...t, ...safe } : t) ?? null;
      snapshot.related_tasks = snapshot.related_tasks?.map((r) => r.related_task_ref === ref ? { ...r, ...safe } : r) ?? null;
    }
  }
}
