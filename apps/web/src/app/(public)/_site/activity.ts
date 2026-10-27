export interface ActivityEvent {
  id: number;
  ts: string;
  agent: string;
  type: string;
  title: string;
}

export const timestamp = (ts: string) => new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC";

export function mergeEvents(previous: ActivityEvent[], incoming: ActivityEvent[], limit = 100) {
  const events = new Map(previous.map((event) => [event.id, event]));
  for (const event of incoming) {
    const existing = events.get(event.id);
    if (!existing || existing.ts !== event.ts || existing.agent !== event.agent || existing.type !== event.type || existing.title !== event.title) events.set(event.id, event);
  }
  const next = [...events.values()].sort((a, b) => a.id - b.id).slice(-limit);
  return next.length === previous.length && next.every((event, index) => event === previous[index]) ? previous : next;
}

export interface Playback {
  events: ActivityEvent[];
  known: number[];
  pending: ActivityEvent[];
  current?: ActivityEvent;
  mode: "replay" | "live";
  initialized: boolean;
}

export const emptyPlayback: Playback = { events: [], known: [], pending: [], mode: "replay", initialized: false };

export function receiveEvents(state: Playback, events: ActivityEvent[], playing: boolean): Playback {
  const history = events.slice(-20);
  const arrivals = state.initialized ? events.filter((event) => !state.known.includes(event.id)) : [];
  let next: Playback = {
    ...state, events: history, known: events.map((event) => event.id), initialized: true,
    pending: mergeEvents(state.pending, arrivals),
    current: state.current ?? history[0],
  };
  if (playing && next.mode === "replay" && next.pending.length) next = advancePlayback(next);
  return next;
}

export function advancePlayback(state: Playback): Playback {
  if (state.pending.length) return { ...state, mode: "live", current: state.pending[0], pending: state.pending.slice(1) };
  const index = state.events.findIndex((event) => event.id === state.current?.id);
  return { ...state, mode: "replay", current: state.events[(index + 1) % state.events.length] };
}

export interface ActivitySnapshot {
  events: ActivityEvent[];
  status: "loading" | "ready" | "error";
}

export const initialSnapshot: ActivitySnapshot = { events: [], status: "loading" };

// One bounded, in-memory cache shared across public route changes. No owner data or storage.
export function createActivityStore(fetcher: typeof fetch = (...args) => fetch(...args)) {
  let snapshot = initialSnapshot;
  let cursor = 0;
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let requestTimeout: ReturnType<typeof setTimeout> | undefined;
  const publish = (next: ActivitySnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const poll = async () => {
    const request = new AbortController();
    controller = request;
    // A stalled request must still reach the unavailable state and retry.
    const timeout = setTimeout(() => request.abort(), 10_000);
    requestTimeout = timeout;
    try {
      const response = await fetcher(`/api/public/agent-events${cursor ? `?since=${cursor}` : ""}`, { signal: request.signal });
      if (!response.ok) throw new Error("Unavailable");
      const feed = await response.json() as { available: boolean; events: ActivityEvent[] };
      if (!feed.available || !Array.isArray(feed.events)) throw new Error("Unavailable");
      if (controller !== request) return;
      const events = mergeEvents(snapshot.events, feed.events);
      cursor = Math.max(cursor, ...events.map((event) => event.id));
      publish({ events, status: "ready" });
    } catch {
      if (controller === request) publish({ ...snapshot, status: "error" });
    } finally {
      clearTimeout(timeout);
      if (controller === request && listeners.size) timer = setTimeout(() => void poll(), 5_000);
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) void poll();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimeout(timer);
          clearTimeout(requestTimeout);
          const request = controller;
          controller = undefined;
          request?.abort();
        }
      };
    },
  };
}
