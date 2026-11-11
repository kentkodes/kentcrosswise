// Monthly model-spend cap (YAGNI: one hard cap, no warning tier, no per-agent cap). The sweep
// computes month-to-date model cost for the current UTC calendar month and, at or above
// SPEND_CAP_USD, pauses agents (system_flags.agents_paused) and dispatches no new agent work.
//
// The cost rule is the one in apps/web/src/server/usage.ts (MODEL_USAGE_SQL), mirrored here as a
// pure function so the sweep can decide without the web app:
//   1. usage_events.cost_usd when it is set (a cost fixed when the row was written wins);
//   2. otherwise tokens x the model_prices row of the same provider+model with the latest
//      effective_from on or before the event's UTC day (missing tokens count as 0);
//   3. otherwise the row is unpriced: it is counted in unpricedEvents and adds $0.
// test/spend-cap.test.ts pins this against the web SQL on the same rows.

/** Hard monthly cap on model spend, USD (the owner's decision). The web panel pins the same value. */
export const SPEND_CAP_USD = 50;

/** A model usage row, as read for the month. `ts` is the event's instant. */
export interface SpendEvent {
  ts: Date;
  provider: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}

/** A model_prices row. `effectiveFrom` is a UTC day, YYYY-MM-DD. Prices are per million tokens. */
export interface SpendPrice {
  provider: string;
  model: string;
  effectiveFrom: string;
  usdPerMtokIn: number;
  usdPerMtokOut: number;
}

export interface MonthSpend {
  /** YYYY-MM (UTC). */
  month: string;
  /** Start of the month (inclusive) and of the next month (exclusive), UTC. */
  start: Date;
  end: Date;
  events: number;
  /** Sum of priced event costs, rounded to micro-dollars. */
  spentUsd: number;
  /** Events with neither a stored cost nor a matching price. Counted, never shown as $0. */
  unpricedEvents: number;
}

/** The UTC calendar month containing `now`. */
export function utcMonth(now: Date): { month: string; start: Date; end: Date } {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const start = new Date(Date.UTC(year, monthIndex, 1));
  const end = new Date(Date.UTC(year, monthIndex + 1, 1));
  const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
  return { month, start, end };
}

const utcDay = (ts: Date) => ts.toISOString().slice(0, 10);

/** Micro-dollar rounding. Applied to the total before any comparison; apps/web/src/server/usage.ts uses the same. */
export const roundMicroUsd = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;

/** The cost of one event in USD, or null when it has no price. */
export function eventCostUsd(event: SpendEvent, prices: readonly SpendPrice[]): number | null {
  if (event.costUsd !== null) return event.costUsd;
  const day = utcDay(event.ts);
  let best: SpendPrice | undefined;
  for (const p of prices) {
    if (p.provider !== event.provider || p.model !== event.model || p.effectiveFrom > day) continue;
    if (best === undefined || p.effectiveFrom > best.effectiveFrom) best = p;
  }
  if (best === undefined) return null;
  return ((event.inputTokens ?? 0) * best.usdPerMtokIn + (event.outputTokens ?? 0) * best.usdPerMtokOut) / 1_000_000;
}

/** Month-to-date model spend for the UTC month containing `now`. Events outside that month are ignored. */
export function monthToDateSpend(events: readonly SpendEvent[], prices: readonly SpendPrice[], now: Date): MonthSpend {
  const { month, start, end } = utcMonth(now);
  let count = 0;
  let spent = 0;
  let unpriced = 0;
  for (const e of events) {
    if (e.ts < start || e.ts >= end) continue;
    count += 1;
    const cost = eventCostUsd(e, prices);
    if (cost === null) unpriced += 1;
    else spent += cost;
  }
  return {
    month,
    start,
    end,
    events: count,
    spentUsd: roundMicroUsd(spent),
    unpricedEvents: unpriced,
  };
}

/** True when the month-to-date spend has reached the cap (at or above it), compared at micro-dollar precision. */
export function capReached(spentUsd: number, capUsd: number = SPEND_CAP_USD): boolean {
  return roundMicroUsd(spentUsd) >= capUsd;
}
