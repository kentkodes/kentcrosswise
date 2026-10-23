// Public agent event feed (DESIGN §4.5, D10, D11): read through web_public, which can read only
// v_public_agent_events. The view already replaces private or untitled tasks with "Private task";
// here we also pick the columns explicitly, so nothing else (task_no, owner text, detail) can leak.
import { DbNotConfiguredError, dbErrorLabel, withDb, type Queryable } from "./db";

export interface PublicEvent {
  id: number;
  ts: string;
  agent: string;
  type: string;
  title: string;
}

export type PublicFeed =
  | { available: true; events: PublicEvent[] }
  | { available: false; events: []; note: string };

export const FEED_LIMIT = 50;

/** The only fields a feed event may have, in order. The e2e test checks the same list. */
export const PUBLIC_EVENT_FIELDS = ["id", "ts", "agent", "type", "title"] as const;

/** Parses `?since=` (an event id cursor). Undefined if absent; null if invalid. */
export function parseSince(value: string | null): number | undefined | null {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

interface Row {
  id: string | number;
  ts: Date | string;
  agent: string;
  event_type: string;
  title: string;
}

/**
 * Without `since`: the latest FEED_LIMIT events. With `since`: up to FEED_LIMIT events after that
 * id. Either way in ascending id order.
 */
export async function queryPublicEvents(db: Queryable, since?: number): Promise<PublicEvent[]> {
  const { rows } =
    since === undefined
      ? await db.query<Row>(
          `SELECT * FROM (
             SELECT id, ts, agent, event_type, title FROM v_public_agent_events ORDER BY id DESC LIMIT $1
           ) latest ORDER BY id`,
          [FEED_LIMIT],
        )
      : await db.query<Row>(
          `SELECT id, ts, agent, event_type, title FROM v_public_agent_events WHERE id > $1 ORDER BY id LIMIT $2`,
          [since, FEED_LIMIT],
        );
  return rows.map((r) => ({
    id: Number(r.id),
    ts: new Date(r.ts).toISOString(),
    agent: r.agent,
    type: r.event_type,
    title: r.title,
  }));
}

export const NOTE_NOT_CONFIGURED = "The agent feed is not connected yet.";
export const NOTE_UNAVAILABLE = "The agent feed is unavailable right now.";

/** The feed, or an empty one with a note when there is no database (prod for now) or it fails. */
export async function loadPublicFeed(
  since?: number,
  run: <T>(fn: (db: Queryable) => Promise<T>) => Promise<T> = (fn) => withDb("web_public", fn, { readOnly: true }),
): Promise<PublicFeed> {
  try {
    return { available: true, events: await run((db) => queryPublicEvents(db, since)) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { available: false, events: [], note: NOTE_NOT_CONFIGURED };
    console.error(`[public-feed] ${dbErrorLabel(err)}`);
    return { available: false, events: [], note: NOTE_UNAVAILABLE };
  }
}
