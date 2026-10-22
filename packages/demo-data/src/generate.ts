import * as P from "./pools";
import { createRng, type Rng } from "./rng";

export const DEMO_SEED = "kcw-demo";
/** Fixed so output never depends on the clock. */
export const DEMO_START = "2026-01-01";

export const ROUTE_KINDS = ["crm_note", "diary", "todo", "idea", "agent_request"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];
export const MOOD_METRICS = [
  "energy", "stress", "happiness", "satisfaction", "sadness", "anger", "anxiety", "gratitude",
] as const;
export type MoodMetric = (typeof MOOD_METRICS)[number];
export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];

// Row shapes mirror packages/db/migrations/0001 (camelCase here, snake_case in SQL).
export interface DemoContact {
  id: string;
  name: string;
  aliases: string[];
  howKnown: string;
  birthday: string; // YYYY-MM-DD
  notes: string;
  tags: string[];
}
export interface DemoEntry {
  id: string;
  createdAt: string; // ISO timestamp, UTC
  source: "web" | "shortcut";
  rawText: string;
  routeKind: RouteKind;
  routeConfidence: number;
  routeModel: string;
  routedBy: "model";
  status: "routed" | "needs_owner";
}
export interface DemoCrmNote {
  id: string;
  entryId: string;
  contactId: string | null;
  body: string;
  linkStatus: "linked" | "ambiguous" | "none";
}
export interface DemoDiaryEntry {
  id: string;
  entryId: string | null;
  body: string;
  writtenAt: string;
}
export type DemoMood = { diaryEntryId: string; sentiment: number; model: string; scoredAt: string } & Record<
  MoodMetric,
  number
>;
export interface DemoTodo {
  id: string;
  entryId: string;
  body: string;
  done: boolean;
  createdAt: string;
}
export interface DemoIdea {
  id: string;
  entryId: string;
  body: string;
  status: "open" | "done" | "dropped";
  createdAt: string;
}
export interface DemoSocialAccount {
  id: string;
  platform: Platform;
  handle: string;
  ingest: "api" | "manual";
}
export interface DemoSocialSnapshot {
  accountId: string;
  day: string;
  followers: number;
  views: number;
  followersExact: boolean;
}
export interface DemoProject {
  slug: string;
  title: string;
  sort: number;
}

export interface DemoData {
  seed: string;
  start: string;
  days: number;
  contacts: DemoContact[];
  entries: DemoEntry[];
  crmNotes: DemoCrmNote[];
  diaryEntries: DemoDiaryEntry[];
  moods: DemoMood[];
  todos: DemoTodo[];
  ideas: DemoIdea[];
  socialAccounts: DemoSocialAccount[];
  socialSnapshots: DemoSocialSnapshot[];
  projects: DemoProject[];
}

export interface GenerateOptions {
  seed?: string;
  /** First day, YYYY-MM-DD (UTC). */
  start?: string;
  days?: number;
  contacts?: number;
}

const DEMO_MODEL = "demo-synthetic";
const DAY_MS = 86_400_000;

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function dayIso(startMs: number, day: number): string {
  return new Date(startMs + day * DAY_MS).toISOString().slice(0, 10);
}
function timeIso(startMs: number, day: number, minuteOfDay: number): string {
  return new Date(startMs + day * DAY_MS + minuteOfDay * 60_000).toISOString();
}

/**
 * Deterministic synthetic data for the public demo and the CI seed.
 * Same options, same output (deep-equal), on every machine.
 */
export function generateDemoData(opts: GenerateOptions = {}): DemoData {
  const seed = opts.seed ?? DEMO_SEED;
  const start = opts.start ?? DEMO_START;
  const days = opts.days ?? 90;
  const nContacts = opts.contacts ?? 12;
  const startMs = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(startMs)) throw new Error(`Bad start date "${start}"`);
  if (!(days >= 1 && nContacts >= 1)) throw new Error("days and contacts must be >= 1");

  // Independent streams per section, so adding a field to one section does not reshuffle the others.
  const r = (section: string): Rng => createRng(`${seed}/${section}`);

  const contacts = makeContacts(r("contacts"), nContacts, startMs);
  const out: DemoData = {
    seed,
    start,
    days,
    contacts,
    entries: [],
    crmNotes: [],
    diaryEntries: [],
    moods: [],
    todos: [],
    ideas: [],
    socialAccounts: [],
    socialSnapshots: [],
    projects: [{ slug: "essays", title: "Essays", sort: 0 }],
  };

  // Mood: a bounded random walk per metric, one diary entry per day.
  const moodRng = r("mood");
  const level = Object.fromEntries(MOOD_METRICS.map((m) => [m, moodRng.float(0.3, 0.7)])) as Record<MoodMetric, number>;
  const entryRng = r("entries");

  for (let day = 0; day < days; day++) {
    for (const m of MOOD_METRICS) level[m] = clamp(level[m] + moodRng.float(-0.12, 0.12), 0.02, 0.98);
    const writtenAt = timeIso(startMs, day, entryRng.int(19 * 60, 23 * 60));
    const diaryEntry = makeEntry(entryRng, "diary", writtenAt, diaryText(entryRng));
    out.entries.push(diaryEntry);
    const diaryId = entryRng.uuid();
    out.diaryEntries.push({ id: diaryId, entryId: diaryEntry.id, body: diaryEntry.rawText, writtenAt });
    const positive = level.happiness + level.satisfaction + level.gratitude + level.energy;
    const negative = level.sadness + level.anger + level.anxiety + level.stress;
    out.moods.push({
      diaryEntryId: diaryId,
      ...(Object.fromEntries(MOOD_METRICS.map((m) => [m, round3(level[m])])) as Record<MoodMetric, number>),
      sentiment: round3(clamp((positive - negative) / 2.5, -1, 1)),
      model: DEMO_MODEL,
      scoredAt: writtenAt,
    });

    // A few captures per day of the other kinds.
    const extra = entryRng.int(0, 2);
    for (let i = 0; i < extra; i++) {
      const kind = entryRng.pick(["crm_note", "todo", "idea", "todo", "crm_note"] as const);
      const at = timeIso(startMs, day, entryRng.int(8 * 60, 18 * 60));
      if (kind === "crm_note") {
        const c = entryRng.pick(contacts);
        const first = c.name.split(" ")[0] ?? c.name;
        const text = entryRng.chance(0.5)
          ? `Caught up with ${first} about ${entryRng.pick(P.TOPICS)}.`
          : `${entryRng.pick(P.PLANS)} with ${first} next ${entryRng.pick(P.WEEKDAYS)}`;
        const e = makeEntry(entryRng, "crm_note", at, text);
        out.entries.push(e);
        out.crmNotes.push({ id: entryRng.uuid(), entryId: e.id, contactId: c.id, body: text, linkStatus: "linked" });
      } else if (kind === "todo") {
        const e = makeEntry(entryRng, "todo", at, entryRng.pick(P.TODOS));
        out.entries.push(e);
        out.todos.push({ id: entryRng.uuid(), entryId: e.id, body: e.rawText, done: entryRng.chance(0.6), createdAt: at });
      } else {
        const e = makeEntry(entryRng, "idea", at, entryRng.pick(P.IDEAS));
        out.entries.push(e);
        out.ideas.push({
          id: entryRng.uuid(),
          entryId: e.id,
          body: e.rawText,
          status: entryRng.pick(["open", "open", "done", "dropped"] as const),
          createdAt: at,
        });
      }
    }
  }

  // Social: daily growth with occasional spikes.
  const socialRng = r("social");
  for (const platform of PLATFORMS) {
    const account: DemoSocialAccount = {
      id: socialRng.uuid(),
      platform,
      handle: `demo-${platform}`,
      ingest: platform === "tiktok" ? "manual" : "api",
    };
    out.socialAccounts.push(account);
    let followers = socialRng.int(300, 5000);
    let views = followers * socialRng.int(5, 20);
    for (let day = 0; day < days; day++) {
      const spike = socialRng.chance(0.05) ? socialRng.int(50, 400) : 0;
      followers = Math.max(0, followers + socialRng.int(-3, 12) + spike);
      views += socialRng.int(20, 400) + spike * 10;
      out.socialSnapshots.push({
        accountId: account.id,
        day: dayIso(startMs, day),
        // YouTube's subscriberCount is rounded (research/apis.md §1): mirror that.
        followers: platform === "youtube" ? roundYoutube(followers) : followers,
        views,
        followersExact: platform !== "youtube",
      });
    }
  }

  return out;
}

function roundYoutube(n: number): number {
  if (n < 1000) return n;
  const digits = Math.floor(Math.log10(n)) + 1;
  const keep = 10 ** (digits - 3);
  return Math.floor(n / keep) * keep;
}

function makeContacts(rng: Rng, n: number, startMs: number): DemoContact[] {
  const names = new Set<string>();
  const out: DemoContact[] = [];
  while (out.length < n) {
    const name = `${rng.pick(P.FIRST_NAMES)} ${rng.pick(P.LAST_NAMES)}`;
    if (names.has(name)) {
      if (names.size >= P.FIRST_NAMES.length * P.LAST_NAMES.length) throw new Error("too many contacts");
      continue;
    }
    names.add(name);
    const first = name.split(" ")[0] ?? name;
    const year = new Date(startMs).getUTCFullYear() - rng.int(22, 60);
    out.push({
      id: rng.uuid(),
      name,
      aliases: rng.chance(0.4) ? [first.slice(0, 3)] : [],
      howKnown: rng.pick(P.HOW_KNOWN),
      birthday: `${year}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
      notes: `Likes ${rng.pick(P.TOPICS)}.`,
      tags: rng.sample(P.TAGS, rng.int(1, 3)),
    });
  }
  return out;
}

function makeEntry(rng: Rng, kind: RouteKind, createdAt: string, rawText: string): DemoEntry {
  const confidence = round3(rng.float(0.55, 0.99));
  return {
    id: rng.uuid(),
    createdAt,
    source: rng.chance(0.8) ? "web" : "shortcut",
    rawText,
    routeKind: kind,
    routeConfidence: confidence,
    routeModel: DEMO_MODEL,
    routedBy: "model",
    status: confidence < 0.7 ? "needs_owner" : "routed",
  };
}

function diaryText(rng: Rng): string {
  return `${rng.pick(P.DIARY_OPENERS)} ${rng.pick(P.DIARY_MIDDLES)} ${rng.pick(P.DIARY_CLOSERS)}`;
}
