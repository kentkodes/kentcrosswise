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

/** Inserts the seed tasks, events and approvals (caller owns the transaction). Returns row counts. */
export async function seedAgents(db: SqlClient): Promise<Record<string, number>> {
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
