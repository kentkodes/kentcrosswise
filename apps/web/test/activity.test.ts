import { afterEach, describe, expect, it, vi } from "vitest";
import { advancePlayback, createActivityStore, emptyPlayback, mergeEvents, receiveEvents, type ActivityEvent } from "../src/app/(public)/_site/activity";

const event = (id: number): ActivityEvent => ({ id, ts: "2026-10-25T12:00:00Z", agent: "developer", type: "task_completed", title: `Public task ${id}` });

afterEach(() => vi.useRealTimers());

describe("public activity", () => {
  it("orders late and duplicate events by cursor and bounds retained events", () => {
    expect(mergeEvents([event(3)], [event(2), event(2), event(1)]).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(mergeEvents([], Array.from({ length: 120 }, (_, i) => event(i + 1)))).toHaveLength(100);
    const previous = [event(1), event(2)];
    expect(mergeEvents(previous, [event(2)])).toBe(previous);
  });

  it("replays only the last 20, loops, and prioritizes new arrivals before quiet replay", () => {
    const events = Array.from({ length: 25 }, (_, i) => event(i + 1));
    let playback = receiveEvents(emptyPlayback, events, true);
    expect(playback.events).toHaveLength(20);
    expect(playback.current?.id).toBe(6);
    for (let i = 0; i < 20; i++) playback = advancePlayback(playback);
    expect(playback.current?.id).toBe(6);
    playback = receiveEvents(playback, [...events, event(26), event(27)], true);
    expect(playback.mode).toBe("live");
    expect(playback.current?.id).toBe(26);
    playback = advancePlayback(playback);
    expect(playback.current?.id).toBe(27);
    expect(advancePlayback(playback).mode).toBe("replay");
  });

  it("keeps paused playback still while queuing fresh events for manual next", () => {
    let playback = receiveEvents(emptyPlayback, [event(1), event(2)], false);
    playback = receiveEvents(playback, [event(1), event(2), event(3)], false);
    expect(playback.current?.id).toBe(1);
    expect(advancePlayback(playback).current?.id).toBe(3);
    expect(receiveEvents(emptyPlayback, [], true).current).toBeUndefined();
  });

  it("polls one shared stream, keeps the max cursor for late responses, caches failures, and cleans up", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ available: true, events: [event(3), event(1)] }))
      .mockResolvedValueOnce(Response.json({ available: true, events: [event(2), event(3)] }))
      .mockResolvedValueOnce(Response.json({ available: false, events: [] }));
    const store = createActivityStore(fetcher);
    const stop1 = store.subscribe(() => {});
    const stop2 = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getSnapshot().events.map((e) => e.id)).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetcher.mock.calls[2]?.[0]).toBe("/api/public/agent-events?since=3");
    expect(store.getSnapshot().status).toBe("error");
    expect(store.getSnapshot().events).toHaveLength(3);
    stop1(); stop2();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes an empty feed from an unavailable feed and cancels an in-flight request", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ available: true, events: [] }))
      .mockRejectedValueOnce(new Error("Network"));
    const store = createActivityStore(fetcher);
    const stop = store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot()).toEqual({ status: "ready", events: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.getSnapshot()).toEqual({ status: "error", events: [] });
    stop();
    const pendingFetch = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = createActivityStore(pendingFetch);
    const cancel = pending.subscribe(() => {});
    const signal = pendingFetch.mock.calls[0]?.[1]?.signal;
    cancel();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
