// The sweeper's database reads, as orch_rw (DESIGN §3.4: tasks, system_flags, inbound_events).
// Read-only: the sweeper never changes a task; the graph does when it processes the sweep message.
// The one write is system_flags.agents_paused = true (the spend cap, spend.ts).
import type { SpendEvent, SpendPrice } from "./spend";

interface SpendEventRow {
  ts: Date | string;
  provider: string;
  model: string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cost_usd: number | string | null;
}

interface SpendPriceRow {
  provider: string;
  model: string;
  effective_from: string;
  usd_per_mtok_in: number | string;
  usd_per_mtok_out: number | string;
}

/** Minimal SQL surface (node-postgres Client/Pool, or PGlite in tests). */
export interface SqlQuery {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Task statuses that get a sweep message (P2-10 contract, §4.3): `waiting` (dev/ci/qa timeouts,
 * the merge step's incomplete-input retry, inputs deferred while paused) and `queued` (a start held
 * back by pause or the in-flight limit). The graph decides what a sweep does in each phase.
 */
export const SWEEP_STATUSES = ["waiting", "queued"] as const;

/**
 * Also swept: `planning` tasks not updated for this many minutes. `planning` is set when a start
 * claims its slot and left when the issue is out and the Developer dispatched (status `waiting`),
 * so an old one is a start whose step failed (planner, GitHub or DB error) after its message was
 * used up. The graph completes a failed step on the next input (processTaskInput: `recovered`),
 * and the start is safe to repeat (the slot is kept, the issue number is stored before dispatch).
 * The age keeps sweeps away from a start that is running right now.
 */
export const STALE_PLANNING_MINUTES = 15;

/** Upper bound of sweep messages per run (D20 keeps in-flight tasks at 4; queued ones can pile up). */
export const MAX_SWEEP_TASKS = 200;

export interface SweepTask {
  id: number;
}

export interface SweeperStore {
  /** Tasks with a SWEEP_STATUSES status or a stale `planning` one, oldest first, at most `limit`. */
  listSweepTasks(limit: number): Promise<SweepTask[]>;
  /** system_flags.agents_paused (Q2). */
  isAgentsPaused(): Promise<boolean>;
  /** Sets system_flags.agents_paused to true. Never sets it to false (the cap never auto-unpauses). */
  setAgentsPaused(): Promise<void>;
  /** Model usage in [start, end) and the price rows for the provider/model pairs in it (spend.ts). */
  monthUsage(start: Date, end: Date): Promise<{ events: SpendEvent[]; prices: SpendPrice[] }>;
  /** The given delivery ids that are already in inbound_events (the relay enqueued them). */
  knownDeliveries(ids: readonly string[]): Promise<Set<string>>;
}

export function sqlSweeperStore(db: SqlQuery): SweeperStore {
  return {
    async listSweepTasks(limit) {
      // The thread id is derived from the id (`task-<id>`, threadIdOf), as the graph checks it; the
      // column is not read (tasks created outside the console may not have it yet).
      const { rows } = await db.query<{ id: string | number }>(
        `SELECT id FROM tasks
         WHERE status = ANY($1::text[])
            OR (status = 'planning' AND updated_at < now() - make_interval(mins => $3))
         ORDER BY id LIMIT $2`,
        [[...SWEEP_STATUSES], limit, STALE_PLANNING_MINUTES],
      );
      return rows.map((r) => ({ id: Number(r.id) }));
    },

    async isAgentsPaused() {
      const { rows } = await db.query<{ value: unknown }>("SELECT value FROM system_flags WHERE key = 'agents_paused'");
      return rows[0]?.value === true;
    },

    async setAgentsPaused() {
      // Same write as the console's setFlag (web_rw). office_enqueue is SECURITY DEFINER (0007).
      await db.query(
        `INSERT INTO system_flags (key, value, updated_at) VALUES ('agents_paused', 'true'::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb, updated_at = now()`,
      );
    },

    async monthUsage(start, end) {
      const { rows: events } = await db.query<SpendEventRow>(
        `SELECT ts, provider, model, input_tokens, output_tokens, cost_usd
           FROM usage_events
          WHERE kind = 'model' AND ts >= $1::timestamptz AND ts < $2::timestamptz
          ORDER BY ts`,
        [start.toISOString(), end.toISOString()],
      );
      // The price rows the rule can pick from: every row of a provider/model pair used in the month.
      // effective_from is a text day (to_char), so no client date parsing is involved.
      const { rows: prices } = await db.query<SpendPriceRow>(
        `SELECT mp.provider, mp.model, to_char(mp.effective_from, 'YYYY-MM-DD') AS effective_from,
                mp.usd_per_mtok_in, mp.usd_per_mtok_out
           FROM model_prices mp
          WHERE (mp.provider, mp.model) IN (
                SELECT DISTINCT u.provider, u.model FROM usage_events u
                 WHERE u.kind = 'model' AND u.ts >= $1::timestamptz AND u.ts < $2::timestamptz)
          ORDER BY mp.provider, mp.model, mp.effective_from`,
        [start.toISOString(), end.toISOString()],
      );
      return {
        events: events.map((r) => ({
          ts: new Date(r.ts),
          provider: r.provider,
          model: r.model,
          inputTokens: r.input_tokens === null ? null : Number(r.input_tokens),
          outputTokens: r.output_tokens === null ? null : Number(r.output_tokens),
          costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
        })),
        prices: prices.map((r) => ({
          provider: r.provider,
          model: r.model,
          effectiveFrom: r.effective_from,
          usdPerMtokIn: Number(r.usd_per_mtok_in),
          usdPerMtokOut: Number(r.usd_per_mtok_out),
        })),
      };
    },

    async knownDeliveries(ids) {
      if (ids.length === 0) return new Set();
      const { rows } = await db.query<{ delivery_id: string }>(
        "SELECT delivery_id FROM inbound_events WHERE delivery_id = ANY($1::text[])",
        [[...ids]],
      );
      return new Set(rows.map((r) => r.delivery_id));
    },
  };
}
