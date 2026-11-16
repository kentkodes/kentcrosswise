// Shared AR3 reconciliation fixture: the same synthetic usage rows are read by the usage page SQL
// (apps/web/src/server/usage.ts) and by the sweep's spending decision (agents/orchestrator
// sweeper store + spend.ts), and both must give these totals. Synthetic providers, models and ids.
// Every row is inside November 2026 up to FIXTURE_NOW, so the page's month-to-date range and the
// sweep's month cover the same rows.

export const FIXTURE_NOW = new Date("2026-11-10T15:00:00Z");

const ENTRY = "00000000-0000-4000-8000-0000000000e1";
const ESSAY = "00000000-0000-4000-8000-0000000000e2";

/** Prices in effect: acme/m1 at $1 in and $2 out per million tokens. acme/m-late has no price yet. */
export const FIXTURE_PRICES_SQL = `
INSERT INTO model_prices (provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from) VALUES
  ('acme', 'm1', 1, 2, '2026-01-01');`;

/**
 * One row per case. Costs: a priced reported call $1; a stored cost $2.50; an invalid answer after
 * a billed response (reported, then refused by the caller) $2; a rejected call $0; an unpriced call
 * (no price for its model); an unknown call and a started call that never ended (usage unknown).
 */
export const FIXTURE_USAGE_SQL = `
INSERT INTO usage_events (ts, kind, agent, provider, model, input_tokens, output_tokens, cost_usd, purpose, subject_kind, subject_id, outcome, dedupe_key) VALUES
  ('2026-11-01T00:00:00Z', 'model', 'orchestrator', 'acme', 'm1',     1000000, 0,       NULL, 'plan',       NULL,    NULL,       'reported', 'call:fx-priced'),
  ('2026-11-02T00:00:00Z', 'model', 'developer',    'acme', 'm1',     10,      10,      2.5,  'work',       NULL,    NULL,       'reported', 'report:1:1:work:0'),
  ('2026-11-03T00:00:00Z', 'model', 'router',       'acme', 'm1',     0,       1000000, NULL, 'route',      'entry', '${ENTRY}', 'reported', 'call:fx-invalid-answer'),
  ('2026-11-04T00:00:00Z', 'model', 'router',       'acme', 'm1',     NULL,    NULL,    NULL, 'route',      'entry', '${ENTRY}', 'rejected', 'call:fx-rejected'),
  ('2026-11-04T00:00:00Z', 'model', 'pipeline',     'acme', 'm-late', 1000,    1000,    NULL, 'categorize', 'essay', '${ESSAY}', 'reported', 'call:fx-unpriced'),
  ('2026-11-05T00:00:00Z', 'model', 'pipeline',     'acme', 'm1',     NULL,    NULL,    NULL, 'hook',       'essay', '${ESSAY}', 'unknown',  'call:fx-unknown'),
  ('2026-11-06T00:00:00Z', 'model', 'router',       'acme', 'm1',     NULL,    NULL,    NULL, 'mood',       'diary_entry', '${ENTRY}', 'started', 'call:fx-started'),
  ('2026-10-31T23:59:59Z', 'model', 'router',       'acme', 'm1',     1000000, 0,       NULL, 'route',      NULL,    NULL,       'reported', 'call:fx-october');`;

/** Month-to-date totals for FIXTURE_NOW (the October row is outside). */
export const FIXTURE_EXPECTED = { events: 7, spentUsd: 5.5, unpricedEvents: 1, unknownEvents: 2 };

/** A price for acme/m-late entered after its call (prices apply retroactively): $10 per million both ways. */
export const FIXTURE_LATE_PRICE_SQL = `
INSERT INTO model_prices (provider, model, usd_per_mtok_in, usd_per_mtok_out, effective_from) VALUES
  ('acme', 'm-late', 10, 10, '2026-11-01');`;

/** After the late price: the unpriced call adds 2000 x $10 / 1M = $0.02. */
export const FIXTURE_EXPECTED_AFTER_LATE_PRICE = { events: 7, spentUsd: 5.52, unpricedEvents: 0, unknownEvents: 2 };

/** The unknown call's late report (dedupe key of the unknown row): 1M input tokens, so +$1. */
export const FIXTURE_LATE_REPORT = { callId: "fx-unknown", inputTokens: 1000000, outputTokens: 0 };
export const FIXTURE_EXPECTED_AFTER_LATE_REPORT = { events: 7, spentUsd: 6.52, unpricedEvents: 0, unknownEvents: 1 };
