import type { Db } from "../db";
import { loadSource, type Health, type PausedBy, type SourceRecord } from "./source";

/** Consecutive failures that set `degraded` and then `broken` (and pause). Design section 2. */
export const DEGRADED_AT = 3;
export const BROKEN_AT = 6;
/** In-run attempts before an essay URL is given up on (`failed`). */
export const MAX_URL_ATTEMPTS = 5;

/** Signals that pause a source at once, never open a repair issue, and turn its URLs link-only. */
export type BlockReason = "robots_disallow" | "blocked_401" | "blocked_403" | "login_required" | "paywall";

export type HealthEvent =
  | { kind: "success"; mode: "discover" | "check" }
  | { kind: "failure"; reason: string }
  | { kind: "block"; reason: BlockReason }
  | { kind: "owner_pause" }
  | { kind: "owner_resume" };

export interface HealthState {
  health: Health;
  healthReason: string | null;
  consecutiveFailures: number;
  pausedBy: PausedBy | null;
}

export interface HealthEffects {
  /** The source just became `degraded`: open one repair issue (deduped by `open_issue`). */
  openIssue: boolean;
  /** Block signal: mark the source's `new` URLs `link_only`. */
  linkOnly: boolean;
  /** Which timestamps to set. */
  touchChecked: boolean;
  touchOk: boolean;
  touchDiscovery: boolean;
}

export interface HealthTransition {
  state: HealthState;
  effects: HealthEffects;
}

const NO_EFFECTS: HealthEffects = { openIssue: false, linkOnly: false, touchChecked: false, touchOk: false, touchDiscovery: false };

export function stateOf(s: Pick<SourceRecord, "health" | "healthReason" | "consecutiveFailures" | "pausedBy">): HealthState {
  return { health: s.health, healthReason: s.healthReason, consecutiveFailures: s.consecutiveFailures, pausedBy: s.pausedBy };
}

/**
 * The health state machine (pure).
 * - 1-2 consecutive failures leave `ok`; 3 sets `degraded`; 6 sets `broken` and pauses (paused_by failures).
 * - A block signal sets `broken` and pauses at once (paused_by block).
 * - Only a successful nightly check restores a degraded or failure-paused source; a discovery success
 *   only resets the counter of a healthy one. Owner and block pauses end with `owner_resume` only.
 * - While paused by the owner or a block, failures and successes are ignored (nothing should be running).
 */
export function nextHealth(state: HealthState, event: HealthEvent): HealthTransition {
  if (event.kind === "owner_pause") return { state: { ...state, pausedBy: "owner" }, effects: NO_EFFECTS };
  if (event.kind === "owner_resume") {
    return {
      state: { health: "ok", healthReason: null, consecutiveFailures: 0, pausedBy: null },
      effects: NO_EFFECTS,
    };
  }
  if (state.pausedBy === "owner" || state.pausedBy === "block") return { state, effects: NO_EFFECTS };

  if (event.kind === "block") {
    return {
      state: { health: "broken", healthReason: event.reason, consecutiveFailures: state.consecutiveFailures, pausedBy: "block" },
      effects: { ...NO_EFFECTS, linkOnly: true, touchChecked: true },
    };
  }

  if (event.kind === "success") {
    const effects = { ...NO_EFFECTS, touchChecked: true, touchOk: true, touchDiscovery: event.mode === "discover" };
    if (event.mode === "check" || state.health === "ok") {
      return { state: { health: "ok", healthReason: null, consecutiveFailures: 0, pausedBy: null }, effects };
    }
    return { state, effects };
  }

  // failure
  const failures = state.consecutiveFailures + 1;
  const effects = { ...NO_EFFECTS, touchChecked: true };
  if (failures >= BROKEN_AT) {
    return { state: { health: "broken", healthReason: event.reason, consecutiveFailures: failures, pausedBy: "failures" }, effects };
  }
  if (failures >= DEGRADED_AT) {
    return {
      state: { health: "degraded", healthReason: event.reason, consecutiveFailures: failures, pausedBy: state.pausedBy },
      effects: { ...effects, openIssue: state.health === "ok" },
    };
  }
  return { state: { ...state, healthReason: event.reason, consecutiveFailures: failures }, effects };
}

/**
 * Loads the source, applies the event and stores the result. Compare-and-set on the old state, so two
 * concurrent events never overwrite each other (the loser re-reads and applies its event again).
 */
export async function recordSourceEvent(db: Db, sourceId: string, event: HealthEvent, now: Date = new Date()): Promise<HealthTransition & { source: SourceRecord }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const source = await loadSource(db, sourceId);
    if (!source) throw new Error(`Unknown source ${sourceId}`);
    const { state, effects } = nextHealth(stateOf(source), event);
    const { rows } = await db.query<{ id: string }>(
      `UPDATE sources
          SET health = $2, health_reason = $3, consecutive_failures = $4, paused_by = $5,
              last_checked_at = CASE WHEN $6 THEN $9::timestamptz ELSE last_checked_at END,
              last_ok_at = CASE WHEN $7 THEN $9::timestamptz ELSE last_ok_at END,
              last_discovery_at = CASE WHEN $8 THEN $9::timestamptz ELSE last_discovery_at END
        WHERE id = $1 AND health = $10 AND consecutive_failures = $11 AND paused_by IS NOT DISTINCT FROM $12
        RETURNING id`,
      [
        source.id, state.health, state.healthReason, state.consecutiveFailures, state.pausedBy,
        effects.touchChecked, effects.touchOk, effects.touchDiscovery, now.toISOString(),
        source.health, source.consecutiveFailures, source.pausedBy,
      ],
    );
    if (!rows[0]) continue;
    if (effects.linkOnly) {
      await db.query("UPDATE essay_urls SET status = 'link_only' WHERE source_id = $1 AND status = 'new'", [source.id]);
    }
    return { state, effects, source: { ...source, ...state, paused: state.pausedBy !== null } };
  }
  throw new Error(`Source ${sourceId}: health update kept conflicting`);
}

export type UrlOutcome =
  | { kind: "fetched" }
  | { kind: "fetch_failed" }
  | { kind: "quarantined" }
  | { kind: "link_only" };

/**
 * Applies an E6/E7 outcome to `essay_urls` (design section 7). `fetch_failed` counts an attempt: the
 * URL stays `new` until MAX_URL_ATTEMPTS, then `failed`. Returns false if the URL is unknown.
 */
export async function recordOutcome(db: Db, url: string, outcome: UrlOutcome): Promise<boolean> {
  const { rows } =
    outcome.kind === "fetch_failed"
      ? await db.query(
          `UPDATE essay_urls
              SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= $2 THEN 'failed' ELSE 'new' END
            WHERE url = $1 RETURNING 1`,
          [url, MAX_URL_ATTEMPTS],
        )
      : await db.query("UPDATE essay_urls SET status = $2 WHERE url = $1 RETURNING 1", [url, outcome.kind]);
  return rows.length > 0;
}
