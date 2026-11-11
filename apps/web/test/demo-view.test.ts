import {
  generateDemoData,
  type DemoContact,
  type DemoCrmNote,
  type DemoData,
  type DemoEntry,
  type DemoIdea,
  type DemoSocialAccount,
  type DemoSocialSnapshot,
  type DemoTodo,
} from "@kcw/demo-data";
import { describe, expect, it } from "vitest";
import { buildDemoView, dayLabel, latestDay } from "../src/app/(public)/demo/demo-view";

const base = () => generateDemoData({ days: 10, contacts: 3 });

function entry(id: string, createdAt: string, routeKind: DemoEntry["routeKind"], rawText: string, status: DemoEntry["status"] = "routed", confidence = 0.9): DemoEntry {
  return { id, createdAt, source: "web", rawText, routeKind, routeConfidence: confidence, routeModel: "demo-synthetic", routedBy: "model", status };
}

function contact(id: string, name: string, howKnown: string, birthday = "1980-03-14"): DemoContact {
  return { id, name, aliases: [], howKnown, birthday, notes: "", tags: [] };
}

function note(id: string, entryId: string, contactId: string | null, body: string): DemoCrmNote {
  return { id, entryId, contactId, body, linkStatus: contactId ? "linked" : "none" };
}

describe("date label", () => {
  it("formats a UTC day as weekday, day and month, with no year", () => {
    expect(dayLabel("2026-11-11")).toBe("Wednesday, 11 November");
    expect(dayLabel("2026-01-03")).toBe("Saturday, 3 January");
  });

  it("takes today from the latest mood or entry in the data, not the wall clock", () => {
    const data = base();
    expect(latestDay(data)).toBe("2026-01-10");
    expect(buildDemoView(data).todayLabel).toBe("Saturday, 10 January");
  });

  it("is deterministic for the same data", () => {
    expect(buildDemoView(base())).toEqual(buildDemoView(base()));
  });
});

describe("today: mood sparkline input", () => {
  it("takes the last 7 sentiments, oldest first", () => {
    const data = base();
    const expected = data.moods.slice(-7).map((m) => m.sentiment);
    expect(buildDemoView(data).today.moodSeries).toEqual(expected);
    expect(expected).toHaveLength(7);
  });
});

describe("today: follow-up", () => {
  const contacts = [contact("a", "Ada Early", "Old friend"), contact("b", "Ben Late", "Work"), contact("c", "Cy None", "Neighbour")];
  const entries = [
    entry("e1", "2026-01-02T10:00:00.000Z", "crm_note", "Met Ada"),
    entry("e2", "2026-01-09T10:00:00.000Z", "crm_note", "Ada again"),
    entry("e3", "2026-01-01T10:00:00.000Z", "crm_note", "Ben call"),
  ];

  it("picks the contact whose latest CRM note is oldest, with the weeks since that note", () => {
    const data: DemoData = {
      ...base(),
      contacts,
      entries,
      crmNotes: [note("n1", "e1", "a", "Ada one"), note("n2", "e2", "a", "Ada two"), note("n3", "e3", "b", "Ben one")],
    };
    const followUp = buildDemoView(data).today.followUp;
    expect(followUp).toEqual({ name: "Ben Late", howKnown: "Work", sinceLastNote: "1 week since last note" });
  });

  it("falls back to the first contact, with no note age, when no contact has a note", () => {
    const data: DemoData = { ...base(), contacts, entries: [], crmNotes: [] };
    expect(buildDemoView(data).today.followUp).toEqual({ name: "Ada Early", howKnown: "Old friend", sinceLastNote: null });
  });
});

describe("today: followers change", () => {
  const account = (id: string, platform: DemoSocialAccount["platform"]): DemoSocialAccount => ({ id, platform, handle: `demo-${platform}`, ingest: "api" });
  const snaps = (accountId: string, counts: number[]): DemoSocialSnapshot[] =>
    counts.map((followers, i) => ({ accountId, day: `2026-01-${String(i + 1).padStart(2, "0")}`, followers, views: 0, followersExact: true }));

  it("uses the account with the most followers and the change over the last 7 snapshots", () => {
    const yt = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190];
    const data: DemoData = {
      ...base(),
      socialAccounts: [account("yt", "youtube"), account("tt", "tiktok")],
      socialSnapshots: [...snaps("yt", yt), ...snaps("tt", [10, 20, 30])],
    };
    const view = buildDemoView(data);
    // Latest 190 minus the snapshot 7 intervals earlier (120): +70, spanning 7 days.
    expect(view.today.followers).toEqual({ platform: "YouTube", count: "190", change: "+70 this week" });
    // Following: 10 snapshots is fewer than the 31 a 30-day window needs, so it uses all of them: +90.
    expect(view.following.map((f) => [f.platform, f.followers, f.change, f.handle])).toEqual([
      ["YouTube", "190", "+90 in 30 days", "demo-youtube"],
      ["TikTok", "30", "+20 in 30 days", "demo-tiktok"],
    ]);
  });

  it("spans exactly 7 and 30 intervals when enough snapshots exist", () => {
    const series = Array.from({ length: 40 }, (_, i) => i); // followers rise by 1 a day
    const data: DemoData = {
      ...base(),
      socialAccounts: [account("yt", "youtube")],
      socialSnapshots: snaps("yt", series),
    };
    const view = buildDemoView(data);
    expect(view.today.followers?.change).toBe("+7 this week");
    expect(view.following[0]?.change).toBe("+30 in 30 days");
  });

  it("shows a negative change with its sign", () => {
    const data: DemoData = {
      ...base(),
      socialAccounts: [account("yt", "youtube")],
      socialSnapshots: snaps("yt", [500, 480, 450]),
    };
    expect(buildDemoView(data).today.followers?.change).toBe("-50 this week");
  });

  it("says no change instead of 0 (rounded counts can stay flat)", () => {
    const data: DemoData = {
      ...base(),
      socialAccounts: [account("yt", "youtube")],
      socialSnapshots: snaps("yt", [5120, 5110, 5120]),
    };
    const view = buildDemoView(data);
    expect(view.today.followers?.change).toBe("no change this week");
    expect(view.following[0]?.change).toBe("no change in 30 days");
  });
});

describe("today: captures", () => {
  it("lists the five newest entries with their route, confidence and linked contact", () => {
    const entries = [
      entry("e1", "2026-01-10T08:00:00.000Z", "todo", "Oldest of the six", "routed", 0.5),
      entry("e2", "2026-01-10T09:00:00.000Z", "idea", "Idea one", "routed", 0.8),
      entry("e3", "2026-01-10T10:00:00.000Z", "crm_note", "Called Ada", "routed", 0.94),
      entry("e4", "2026-01-10T11:00:00.000Z", "diary", "Felt calm", "routed", 0.91),
      entry("e5", "2026-01-10T12:00:00.000Z", "todo", "Unsure task", "needs_owner", 0.6),
      entry("e6", "2026-01-10T13:00:00.000Z", "crm_note", "Unlinked note", "routed", 0.7),
    ];
    const data: DemoData = {
      ...base(),
      contacts: [contact("a", "Ada Early", "Old friend")],
      entries,
      crmNotes: [note("n1", "e3", "a", "Called Ada"), note("n2", "e6", null, "Unlinked note")],
    };
    const captures = buildDemoView(data).today.captures;
    expect(captures).toEqual([
      { text: "Unlinked note", day: "Jan 10", route: "CRM note", detail: "0.70" },
      { text: "Unsure task", day: "Jan 10", route: "Needs you", detail: "0.60" },
      { text: "Felt calm", day: "Jan 10", route: "Diary", detail: "0.91" },
      { text: "Called Ada", day: "Jan 10", route: "CRM note", detail: "Ada Early · 0.94" },
      { text: "Idea one", day: "Jan 10", route: "Idea", detail: "0.80" },
    ]);
  });

  it("labels each capture with its own UTC day", () => {
    const data: DemoData = {
      ...base(),
      entries: [
        entry("e1", "2026-03-30T23:30:00.000Z", "diary", "Late"),
        entry("e2", "2026-03-31T00:10:00.000Z", "idea", "Early"),
      ],
      crmNotes: [],
    };
    expect(buildDemoView(data).today.captures.map((c) => [c.text, c.day])).toEqual([
      ["Early", "Mar 31"],
      ["Late", "Mar 30"],
    ]);
  });
});

describe("people", () => {
  it("shows the first 8 contacts with their latest CRM note and a short birthday", () => {
    const contacts = Array.from({ length: 10 }, (_, i) => contact(`c${i}`, `Person ${i}`, "Friend", "1990-03-14"));
    const data: DemoData = {
      ...base(),
      contacts,
      entries: [entry("e1", "2026-01-02T10:00:00.000Z", "crm_note", "Older"), entry("e2", "2026-01-05T10:00:00.000Z", "crm_note", "Newer")],
      crmNotes: [note("n1", "e1", "c0", "Older note"), note("n2", "e2", "c0", "Newer note")],
    };
    const people = buildDemoView(data).people;
    expect(people).toHaveLength(8);
    expect(people[0]).toEqual({ name: "Person 0", howKnown: "Friend", lastNote: "Newer note", birthday: "Mar 14" });
    expect(people[1]?.lastNote).toBe("—");
  });
});

describe("mood", () => {
  it("lists the latest mood in display order, 2 decimals", () => {
    const data = base();
    const latest = data.moods.at(-1)!;
    const mood = buildDemoView(data).mood;
    expect(mood.map((m) => m.name)).toEqual(["Energy", "Happiness", "Satisfaction", "Gratitude", "Stress", "Anxiety", "Sadness", "Anger"]);
    expect(mood[1]).toEqual({ name: "Happiness", value: latest.happiness, text: latest.happiness.toFixed(2) });
  });
});

describe("notes", () => {
  const todo = (id: string, createdAt: string, body: string, done: boolean): DemoTodo => ({ id, entryId: "e", body, done, createdAt });
  const idea = (id: string, createdAt: string, body: string, status: DemoIdea["status"]): DemoIdea => ({ id, entryId: "e", body, status, createdAt });

  it("keeps open todos, newest first, at most five", () => {
    const data: DemoData = {
      ...base(),
      todos: [
        todo("t1", "2026-01-01T10:00:00.000Z", "T1", false),
        todo("t2", "2026-01-02T10:00:00.000Z", "T2 done", true),
        todo("t3", "2026-01-03T10:00:00.000Z", "T3", false),
        todo("t4", "2026-01-04T10:00:00.000Z", "T4", false),
        todo("t5", "2026-01-05T10:00:00.000Z", "T5", false),
        todo("t6", "2026-01-06T10:00:00.000Z", "T6", false),
        todo("t7", "2026-01-07T10:00:00.000Z", "T7", false),
      ],
    };
    expect(buildDemoView(data).notes.todos).toEqual(["T7", "T6", "T5", "T4", "T3"]);
  });

  it("drops repeated bodies, keeping the newest, and still caps at five", () => {
    const data: DemoData = {
      ...base(),
      todos: [
        todo("t1", "2026-01-01T10:00:00.000Z", "Same", false),
        todo("t2", "2026-01-02T10:00:00.000Z", "Other", false),
        todo("t3", "2026-01-03T10:00:00.000Z", "Same", false),
        todo("t4", "2026-01-04T10:00:00.000Z", "A", false),
        todo("t5", "2026-01-05T10:00:00.000Z", "B", false),
        todo("t6", "2026-01-06T10:00:00.000Z", "C", false),
        todo("t7", "2026-01-07T10:00:00.000Z", "D", false),
      ],
      ideas: [
        idea("i1", "2026-01-01T10:00:00.000Z", "Dup", "open"),
        idea("i2", "2026-01-02T10:00:00.000Z", "Dup", "open"),
        idea("i3", "2026-01-03T10:00:00.000Z", "One", "open"),
        idea("i4", "2026-01-04T10:00:00.000Z", "Two", "open"),
        idea("i5", "2026-01-05T10:00:00.000Z", "Three", "open"),
        idea("i6", "2026-01-06T10:00:00.000Z", "Four", "open"),
        idea("i7", "2026-01-07T10:00:00.000Z", "Five", "open"),
      ],
    };
    const view = buildDemoView(data);
    expect(view.notes.todos).toEqual(["D", "C", "B", "A", "Same"]);
    expect(view.notes.ideas).toEqual(["Five", "Four", "Three", "Two", "One"]);
  });

  it("keeps only open ideas, newest first, at most five", () => {
    const data: DemoData = {
      ...base(),
      ideas: [
        idea("i1", "2026-01-01T10:00:00.000Z", "Open old", "open"),
        idea("i2", "2026-01-02T10:00:00.000Z", "Done", "done"),
        idea("i3", "2026-01-03T10:00:00.000Z", "Dropped", "dropped"),
        idea("i4", "2026-01-04T10:00:00.000Z", "Open new", "open"),
      ],
    };
    expect(buildDemoView(data).notes.ideas).toEqual(["Open new", "Open old"]);
  });
});
