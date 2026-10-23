// Synthetic agent-system rows for previews and local e2e (DESIGN §3.2): a few tasks with events,
// so the public office feed and the boss console have something to show, and pending approvals
// for the inbox. Never real data. Task ids are identities, so idempotency is a marker check:
// if any seed task exists, nothing is inserted.
import type { SqlClient } from "../src/client";

/** Every seed task's owner_text starts with this; the e2e tests look for it. */
export const SEED_TASK_PREFIX = "[seed]";

interface SeedTask {
  key: string;
  ownerText: string;
  publicTitle: string | null;
  isPrivate: boolean;
  status: string;
  waitingOn: string | null;
  events: readonly (readonly [agent: string, type: string])[];
}

/** Public title shown in the feed for the one public seed task. */
export const SEED_PUBLIC_TITLE = "Add a health check page";

const TASKS: readonly SeedTask[] = [
  {
    key: "public",
    ownerText: `${SEED_TASK_PREFIX} Add a /healthz page that returns ok`,
    publicTitle: SEED_PUBLIC_TITLE,
    isPrivate: false,
    status: "waiting",
    waitingOn: "owner",
    events: [
      ["orchestrator", "task_assigned"],
      ["developer", "coding"],
      ["developer", "pr_opened"],
      ["orchestrator", "ci_running"],
      ["orchestrator", "ci_passed"],
      ["qa", "qa_reviewing"],
      ["qa", "approved"],
      ["orchestrator", "waiting_on_owner"],
    ],
  },
  {
    // Private with a title: the feed must show "Private task", never this title or the owner text.
    key: "private",
    ownerText: `${SEED_TASK_PREFIX} Private synthetic request for Example Person`,
    publicTitle: "Seed private title must not appear",
    isPrivate: true,
    status: "in_progress",
    waitingOn: "dev",
    events: [
      ["orchestrator", "task_assigned"],
      ["developer", "coding"],
    ],
  },
  {
    // Public but no title yet: also "Private task".
    key: "untitled",
    ownerText: `${SEED_TASK_PREFIX} Untitled synthetic task`,
    publicTitle: null,
    isPrivate: false,
    status: "failed",
    waitingOn: null,
    events: [
      ["orchestrator", "task_assigned"],
      ["developer", "tests_failed"],
      ["orchestrator", "failed"],
    ],
  },
];

/** Pending approvals on the public seed task (deterministic ids). */
export const SEED_APPROVALS = [
  { id: "5eed0000-0000-4000-8000-000000000001", kind: "critical_pr", reasons: ["seed: infra/prod changed"] },
  { id: "5eed0000-0000-4000-8000-000000000002", kind: "critical_pr", reasons: ["seed: new dependency"] },
] as const;

/**
 * Synthetic model prices for the usage panel: provider `seed`, made-up numbers (never vendor
 * prices; real prices are entered from the vendor pages). seed-small changes price 10 days ago;
 * seed-unpriced has no price, so the panel shows "no price".
 */
export const SEED_MODEL_PRICES = [
  { model: "seed-small", in: 1, out: 2, daysAgo: 400 },
  { model: "seed-small", in: 2, out: 4, daysAgo: 10 },
  { model: "seed-large", in: 5, out: 10, daysAgo: 400 },
] as const;

/** Synthetic usage within the last 30 days: [agent, model, input tokens, output tokens, days ago]. */
const SEED_MODEL_USAGE: readonly (readonly [agent: string, model: string, input: number, output: number, daysAgo: number])[] = [
  ["orchestrator", "seed-small", 120_000, 8_000, 20],
  ["orchestrator", "seed-small", 90_000, 6_000, 2],
  ["developer", "seed-large", 400_000, 40_000, 12],
  ["developer", "seed-large", 250_000, 30_000, 1],
  ["qa", "seed-small", 60_000, 5_000, 1],
  ["router", "seed-unpriced", 3_000, 100, 3],
];

/** Synthetic Actions minutes: [agent, minutes, days ago]; dedupe keys `seed:workflow_run:<n>`. */
const SEED_ACTIONS: readonly (readonly [agent: string, minutes: number, daysAgo: number])[] = [
  ["orchestrator", 7.5, 12],
  ["developer", 4.25, 1],
];

/** Inserts the seed tasks, events, approvals and usage (caller owns the transaction). Returns row counts. */
export async function seedAgents(db: SqlClient): Promise<Record<string, number>> {
  return { ...(await seedTasks(db)), ...(await seedUsage(db)) };
}

async function seedTasks(db: SqlClient): Promise<Record<string, number>> {
  const counts = { tasks: 0, agent_events: 0, approvals: 0 };
  const existing = await db.query("SELECT 1 FROM tasks WHERE starts_with(owner_text, $1) LIMIT 1", [SEED_TASK_PREFIX]);
  if (existing.rows.length > 0) return counts;

  const ids = new Map<string, number>();
  for (const t of TASKS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tasks (source, owner_text, public_title, is_private, status, waiting_on)
       VALUES ('console', $1, $2, $3, $4, $5) RETURNING id`,
      [t.ownerText, t.publicTitle, t.isPrivate, t.status, t.waitingOn],
    );
    const id = Number(rows[0]!.id);
    ids.set(t.key, id);
    await db.query("UPDATE tasks SET thread_id = 'task-' || id WHERE id = $1", [id]);
    counts.tasks++;
    let minute = 0;
    for (const [agent, type] of t.events) {
      await db.query(
        `INSERT INTO agent_events (task_id, agent, event_type, ts, detail)
         VALUES ($1, $2, $3, now() - make_interval(mins => $4), '{"seed": true}')`,
        [id, agent, type, 60 - minute++],
      );
      counts.agent_events++;
    }
  }
  for (const a of SEED_APPROVALS) {
    await db.query(
      `INSERT INTO approvals (id, task_id, kind, reasons) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [a.id, ids.get("public"), a.kind, a.reasons],
    );
    counts.approvals++;
  }
  return counts;
}

/**
 * Synthetic usage for the usage panel, with its own marker (seed Actions rows), so a database whose
 * seed tasks predate this seed still gets usage.
 */
async function seedUsage(db: SqlClient): Promise<Record<string, number>> {
  const counts = { model_prices: 0, usage_events: 0 };
  const existing = await db.query("SELECT 1 FROM usage_events WHERE starts_with(dedupe_key, 'seed:') LIMIT 1");
  if (existing.rows.length > 0) return counts;
  const task = await db.query<{ id: string }>("SELECT id FROM tasks WHERE owner_text = $1 ORDER BY id LIMIT 1", [
    TASKS[0]!.ownerText,
  ]);
  const publicTask = task.rows[0] ? Number(task.rows[0].id) : null;

  // Prices are dated relative to today, so they are inserted with the usage, once.
  for (const p of SEED_MODEL_PRICES) {
    const { rows } = await db.query(
      `INSERT INTO model_prices (provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from)
       VALUES ('seed', $1, $2, $3, current_date - $4::int) ON CONFLICT DO NOTHING RETURNING 1`,
      [p.model, p.in, p.out, p.daysAgo],
    );
    counts.model_prices += rows.length;
  }
  for (const [agent, model, input, output, daysAgo] of SEED_MODEL_USAGE) {
    await db.query(
      `INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, task_id)
       VALUES (now() - make_interval(days => $5), 'model', $1, 'seed', $2, $3, $4, $6)`,
      [agent, model, input, output, daysAgo, publicTask],
    );
    counts.usage_events++;
  }
  let run = 0;
  for (const [agent, minutes, daysAgo] of SEED_ACTIONS) {
    await db.query(
      `INSERT INTO usage_events (ts, kind, agent, minutes, cost_usd, dedupe_key)
       VALUES (now() - make_interval(days => $3), 'actions_minutes', $1, $2, 0, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
      [agent, minutes, daysAgo, `seed:workflow_run:${++run}`],
    );
    counts.usage_events++;
  }
  return counts;
}
