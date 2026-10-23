"use client";
// Polls /api/public/agent-events every 5 s (D11) and lists the events, newest first.
import { useEffect, useState } from "react";

interface FeedEvent {
  id: number;
  ts: string;
  agent: string;
  type: string;
  title: string;
}

type Feed = { available: true; events: FeedEvent[] } | { available: false; events: []; note: string };

const POLL_MS = 5_000;
const KEEP = 100;

export function OfficeFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [note, setNote] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let lastId: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const url = lastId === undefined ? "/api/public/agent-events" : `/api/public/agent-events?since=${lastId}`;
        const res = await fetch(url);
        const feed = (await res.json()) as Feed;
        if (cancelled) return;
        if (feed.available) {
          setNote(undefined);
          if (feed.events.length > 0) {
            lastId = feed.events[feed.events.length - 1]!.id;
            setEvents((prev) => {
              const seen = new Set(prev.map((e) => e.id));
              return [...prev, ...feed.events.filter((e) => !seen.has(e.id))].slice(-KEEP);
            });
          }
        } else {
          setNote(feed.note);
        }
      } catch {
        if (!cancelled) setNote("The agent feed is unavailable right now.");
      } finally {
        if (!cancelled) {
          setLoaded(true);
          timer = setTimeout(poll, POLL_MS);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!loaded) return <p>Loading events...</p>;
  return (
    <section aria-label="Agent events">
      {note ? <p role="status">{note}</p> : null}
      {events.length === 0 && !note ? <p>No agent events yet.</p> : null}
      <ol data-testid="agent-events" reversed>
        {[...events].reverse().map((e) => (
          <li key={e.id} data-event-id={e.id}>
            <time dateTime={e.ts}>{new Date(e.ts).toISOString().replace("T", " ").slice(0, 19)} UTC</time>{" "}
            <span data-field="agent">{e.agent}</span> <span data-field="type">{e.type.replaceAll("_", " ")}</span>
            {": "}
            <span data-field="title">{e.title}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
