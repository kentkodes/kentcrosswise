// View model for /demo: a small, serializable picture of the simulated hub, built from @kcw/demo-data.
// Pure: no clock and no React. "Today" is the latest day present in the data, so the output is deterministic.
import type { DemoContact, DemoData, MoodMetric, Platform, RouteKind } from "@kcw/demo-data";

export interface DemoView {
  /** "Wednesday, 11 November" (UTC), for the latest day in the data. */
  todayLabel: string;
  today: {
    /** Sentiment of the last 7 mood scores, oldest first. Drawn as the sparkline. */
    moodSeries: number[];
    followUp: { name: string; howKnown: string; sinceLastNote: string | null } | null;
    /** The account with the most followers. `change` is signed, over the last 7 snapshots. */
    followers: { platform: string; count: string; change: string } | null;
    /** Newest first. `day` is "Mar 31" (UTC) from the entry's createdAt. */
    captures: { text: string; day: string; route: string; detail: string }[];
  };
  people: { name: string; howKnown: string; lastNote: string; birthday: string }[];
  /** Latest mood, in display order. `value` is 0 to 1. */
  mood: { name: string; value: number; text: string }[];
  /** `change` is signed, over the last 30 snapshots. */
  following: { platform: string; followers: string; change: string; handle: string }[];
  notes: { todos: string[]; ideas: string[] };
}

const DAY_MS = 86_400_000;
const LIST_CAP = 5;
// Change windows: N intervals need N + 1 snapshots, so "this week" spans 7 days and "in 30 days" spans 30.
const TODAY_INTERVALS = 7;
const FOLLOWING_INTERVALS = 30;

const ROUTE_LABEL: Record<RouteKind, string> = {
  crm_note: "CRM note",
  diary: "Diary",
  todo: "To do",
  idea: "Idea",
  agent_request: "Agent request",
};
const PLATFORM_LABEL: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };
// Display order: positive feelings first, then the negative ones.
const MOOD_ORDER: MoodMetric[] = ["energy", "happiness", "satisfaction", "gratitude", "stress", "anxiety", "sadness", "anger"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const dayOf = (iso: string) => iso.slice(0, 10);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString("en-US")}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Keeps the first (newest, once sorted) row for each body, at most LIST_CAP rows. */
function uniqueBodies<T extends { body: string; createdAt: string }>(rows: T[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of [...rows].sort(newestFirst)) {
    if (seen.has(row.body)) continue;
    seen.add(row.body);
    out.push(row.body);
    if (out.length === LIST_CAP) break;
  }
  return out;
}

/** Newest first; ISO timestamps sort correctly as strings. */
const newestFirst = <T extends { createdAt: string }>(a: T, b: T) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

/** "Wednesday, 11 November" for a YYYY-MM-DD day, in UTC, with no year. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(d);
  const month = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" }).format(d);
  return `${weekday}, ${d.getUTCDate()} ${month}`;
}

/** "Mar 14" from a YYYY-MM-DD birthday. */
function birthdayLabel(date: string): string {
  const [, month = "1", day = "1"] = date.split("-");
  return `${MONTHS[Number(month) - 1] ?? ""} ${Number(day)}`;
}

/** "Mar 31" from an ISO timestamp, in UTC. */
function shortDayLabel(iso: string): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()] ?? ""} ${d.getUTCDate()}`;
}

/** The latest day present in the data (mood scores and entries), never the wall clock. */
export function latestDay(data: DemoData): string {
  const stamps = [...data.moods.map((m) => m.scoredAt), ...data.entries.map((e) => e.createdAt)];
  return dayOf(stamps.reduce((a, b) => (b > a ? b : a), data.start));
}

export function buildDemoView(data: DemoData): DemoView {
  const today = latestDay(data);
  const entryById = new Map(data.entries.map((e) => [e.id, e]));
  const contactById = new Map<string, DemoContact>(data.contacts.map((c) => [c.id, c]));

  // A CRM note's date is its entry's createdAt.
  const datedNotes = data.crmNotes.flatMap((n) => {
    const entry = entryById.get(n.entryId);
    return entry ? [{ ...n, createdAt: entry.createdAt }] : [];
  });
  const latestNoteByContact = new Map<string, { createdAt: string; body: string }>();
  for (const n of datedNotes) {
    if (!n.contactId) continue;
    const seen = latestNoteByContact.get(n.contactId);
    if (!seen || n.createdAt > seen.createdAt) latestNoteByContact.set(n.contactId, { createdAt: n.createdAt, body: n.body });
  }

  return {
    todayLabel: dayLabel(today),
    today: {
      moodSeries: data.moods.slice(-7).map((m) => m.sentiment),
      followUp: followUp(data, latestNoteByContact, today),
      followers: topFollowers(data),
      captures: captures(data, contactById),
    },
    people: data.contacts.slice(0, 8).map((c) => ({
      name: c.name,
      howKnown: c.howKnown,
      lastNote: latestNoteByContact.get(c.id)?.body ?? "—",
      birthday: birthdayLabel(c.birthday),
    })),
    mood: moodRows(data),
    following: data.socialAccounts.map((account) => {
      const snaps = snapshotsOf(data, account.id);
      const latest = snaps.at(-1);
      return {
        platform: PLATFORM_LABEL[account.platform],
        followers: (latest?.followers ?? 0).toLocaleString("en-US"),
        change: ((c) => (c === 0 ? "no change in 30 days" : `${signed(c)} in 30 days`))(windowChange(snaps, FOLLOWING_INTERVALS)),
        handle: account.handle,
      };
    }),
    notes: {
      todos: uniqueBodies(data.todos.filter((t) => !t.done)),
      ideas: uniqueBodies(data.ideas.filter((i) => i.status === "open")),
    },
  };
}

/** Oldest latest CRM note wins. With no notes at all, the first contact is chosen, with no note age. */
function followUp(
  data: DemoData,
  latestNoteByContact: Map<string, { createdAt: string; body: string }>,
  today: string,
): DemoView["today"]["followUp"] {
  let pick: { contact: DemoData["contacts"][number]; createdAt: string } | undefined;
  for (const contact of data.contacts) {
    const latest = latestNoteByContact.get(contact.id);
    if (latest && (!pick || latest.createdAt < pick.createdAt)) pick = { contact, createdAt: latest.createdAt };
  }
  if (pick) {
    const weeks = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dayOf(pick.createdAt)}T00:00:00Z`)) / (7 * DAY_MS));
    return { name: pick.contact.name, howKnown: pick.contact.howKnown, sinceLastNote: `${plural(weeks, "week")} since last note` };
  }
  const first = data.contacts[0];
  return first ? { name: first.name, howKnown: first.howKnown, sinceLastNote: null } : null;
}

/** The account with the most followers at its latest snapshot (first one on a tie). */
function topFollowers(data: DemoData): DemoView["today"]["followers"] {
  let best: { platform: string; latest: number; change: number } | undefined;
  for (const account of data.socialAccounts) {
    const snaps = snapshotsOf(data, account.id);
    const latest = snaps.at(-1);
    if (!latest) continue;
    if (!best || latest.followers > best.latest) {
      best = { platform: PLATFORM_LABEL[account.platform], latest: latest.followers, change: windowChange(snaps, TODAY_INTERVALS) };
    }
  }
  return best ? { platform: best.platform, count: best.latest.toLocaleString("en-US"), change: best.change === 0 ? "no change this week" : `${signed(best.change)} this week` } : null;
}

/** The latest entries of any kind, newest first, with where each one went. */
function captures(data: DemoData, contactById: Map<string, DemoContact>): DemoView["today"]["captures"] {
  const linkedContact = new Map<string, string>();
  for (const n of data.crmNotes) {
    if (n.linkStatus !== "linked" || !n.contactId) continue;
    const name = contactById.get(n.contactId)?.name;
    if (name) linkedContact.set(n.entryId, name);
  }
  return [...data.entries]
    .sort(newestFirst)
    .slice(0, 5)
    .map((entry) => {
      const contact = linkedContact.get(entry.id);
      const confidence = entry.routeConfidence.toFixed(2);
      return {
        text: entry.rawText,
        day: shortDayLabel(entry.createdAt),
        route: entry.status === "needs_owner" ? "Needs you" : ROUTE_LABEL[entry.routeKind],
        detail: contact ? `${contact} · ${confidence}` : confidence,
      };
    });
}

function moodRows(data: DemoData): DemoView["mood"] {
  const latest = data.moods.at(-1);
  if (!latest) return [];
  return MOOD_ORDER.map((m) => ({ name: capitalise(m), value: latest[m], text: latest[m].toFixed(2) }));
}

function snapshotsOf(data: DemoData, accountId: string) {
  return data.socialSnapshots.filter((s) => s.accountId === accountId).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/** Latest followers minus the followers `intervals` snapshots earlier (or the first snapshot, if fewer exist). */
function windowChange(snaps: { followers: number }[], intervals: number): number {
  const window = snaps.slice(-(intervals + 1));
  const first = window[0];
  const last = window.at(-1);
  return first && last ? last.followers - first.followers : 0;
}
