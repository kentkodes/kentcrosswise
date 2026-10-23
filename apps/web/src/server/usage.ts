// Usage panel data (P2-15, DESIGN §3.2, §11 Q13). Runs as web_rw, owner pages only. All the
// aggregation SQL lives here.
//
// Cost of a model usage row, in this order:
//   1. usage_events.cost_usd when it is set (a cost fixed when the row was written wins);
//   2. otherwise tokens x the model_prices row of the same provider+model with the latest
//      effective_from on or before the event's UTC day (prices are never hardcoded);
//   3. otherwise no price: the row counts in "events without a price", never as $0.
// Actions minutes (kind 'actions_minutes') are summed separately and cost $0 (public repo,
// standard runners). Days are UTC.
import type { Queryable } from "./db";

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;

/** An inclusive range of UTC days, as YYYY-MM-DD. */
export interface DayRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function parseDay(v: unknown): number | undefined {
  if (typeof v !== "string" || !DAY.test(v)) return undefined;
  const ms = Date.parse(`${v}T00:00:00Z`);
  // Date.parse accepts 2026-02-30 by rolling over; require a round trip.
  return Number.isFinite(ms) && dayOf(ms) === v ? ms : undefined;
}

/**
 * The range from query parameters. Missing or invalid input gives the default (the last 30 days
 * up to `today`); `adjusted` tells the page to say so.
 */
export function parseRange(from: unknown, to: unknown, now: Date = new Date()): DayRange & { adjusted: boolean } {
  const today = Date.parse(`${dayOf(now.getTime())}T00:00:00Z`);
  const fallback = { from: dayOf(today - (DEFAULT_RANGE_DAYS - 1) * DAY_MS), to: dayOf(today) };
  if (from === undefined && to === undefined) return { ...fallback, adjusted: false };
  const f = parseDay(from);
  const t = parseDay(to);
  if (f === undefined || t === undefined || f > t || (t - f) / DAY_MS >= MAX_RANGE_DAYS) return { ...fallback, adjusted: true };
  return { from: dayOf(f), to: dayOf(t), adjusted: false };
}

/** One group of model usage. `costUsd` is null when no event in the group has a price. */
export interface UsageGroup {
  key: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** Events in the group that have neither cost_usd nor a matching model_prices row. */
  unpricedEvents: number;
}

export interface UsageSummary {
  range: DayRange;
  total: UsageGroup;
  byAgent: UsageGroup[];
  /** Key `provider/model`. */
  byModel: UsageGroup[];
  /** Key `YYYY-MM-DD` (UTC), days with usage only, oldest first. */
  byDay: UsageGroup[];
  actions: { minutes: number; runs: number };
}

type GroupRow = {
  agent_set: number;
  model_set: number;
  day_set: number;
  agent: string | null;
  provider: string | null;
  model: string | null;
  day: string | null;
  events: string;
  input_tokens: string;
  output_tokens: string;
  cost_usd: string | null;
  unpriced: string;
};

// $1, $2: start (inclusive) and end (exclusive) as timestamptz. GROUPING() is 0 when the column
// is part of the row's grouping set.
const MODEL_USAGE_SQL = `
WITH priced AS (
  SELECT u.agent, u.provider, u.model, u.input_tokens, u.output_tokens,
         to_char(u.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         CASE
           WHEN u.cost_usd IS NOT NULL THEN u.cost_usd
           WHEN p.usd_per_mtok_in IS NOT NULL THEN
             (coalesce(u.input_tokens, 0) * p.usd_per_mtok_in + coalesce(u.output_tokens, 0) * p.usd_per_mtok_out) / 1000000
         END AS cost
    FROM usage_events u
    LEFT JOIN LATERAL (
      SELECT mp.usd_per_mtok_in, mp.usd_per_mtok_out
        FROM model_prices mp
       WHERE mp.provider = u.provider AND mp.model = u.model
         AND mp.effective_from <= (u.ts AT TIME ZONE 'UTC')::date
       ORDER BY mp.effective_from DESC
       LIMIT 1
    ) p ON true
   WHERE u.kind = 'model' AND u.ts >= $1::timestamptz AND u.ts < $2::timestamptz
)
SELECT GROUPING(agent) AS agent_set, GROUPING(provider, model) AS model_set, GROUPING(day) AS day_set,
       agent, provider, model, day,
       count(*) AS events,
       coalesce(sum(input_tokens), 0) AS input_tokens,
       coalesce(sum(output_tokens), 0) AS output_tokens,
       sum(cost) AS cost_usd,
       count(*) FILTER (WHERE cost IS NULL) AS unpriced
  FROM priced
 GROUP BY GROUPING SETS ((agent), (provider, model), (day), ())
`;

const ACTIONS_SQL = `
SELECT coalesce(sum(minutes), 0) AS minutes, count(*) AS runs
  FROM usage_events
 WHERE kind = 'actions_minutes' AND ts >= $1::timestamptz AND ts < $2::timestamptz
`;

const emptyGroup = (key: string): UsageGroup => ({
  key,
  events: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  unpricedEvents: 0,
});

function toGroup(key: string, r: GroupRow): UsageGroup {
  return {
    key,
    events: Number(r.events),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
    unpricedEvents: Number(r.unpriced),
  };
}

/** Largest cost first, unpriced groups last; ties by key. */
const byCost = (a: UsageGroup, b: UsageGroup) =>
  (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.events - a.events || a.key.localeCompare(b.key);

export async function usageSummary(db: Queryable, range: DayRange): Promise<UsageSummary> {
  const start = `${range.from}T00:00:00Z`;
  const end = new Date(Date.parse(`${range.to}T00:00:00Z`) + DAY_MS).toISOString();
  const { rows } = await db.query<GroupRow>(MODEL_USAGE_SQL, [start, end]);
  const summary: UsageSummary = {
    range: { from: range.from, to: range.to },
    total: emptyGroup("total"),
    byAgent: [],
    byModel: [],
    byDay: [],
    actions: { minutes: 0, runs: 0 },
  };
  for (const r of rows) {
    if (Number(r.agent_set) === 0) summary.byAgent.push(toGroup(r.agent!, r));
    else if (Number(r.model_set) === 0) summary.byModel.push(toGroup(`${r.provider}/${r.model}`, r));
    else if (Number(r.day_set) === 0) summary.byDay.push(toGroup(r.day!, r));
    else summary.total = toGroup("total", r);
  }
  summary.byAgent.sort(byCost);
  summary.byModel.sort(byCost);
  summary.byDay.sort((a, b) => a.key.localeCompare(b.key));

  const actions = await db.query<{ minutes: string; runs: string }>(ACTIONS_SQL, [start, end]);
  summary.actions = { minutes: Number(actions.rows[0]!.minutes), runs: Number(actions.rows[0]!.runs) };
  return summary;
}

/** `$1.23`, or 4 decimals under a dollar; null is "no price". */
export function formatUsd(v: number | null): string {
  if (v === null) return "no price";
  return `$${v.toFixed(v < 1 ? 4 : 2)}`;
}
