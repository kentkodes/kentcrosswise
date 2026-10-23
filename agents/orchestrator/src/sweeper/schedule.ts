// Time windows of the sweeper (DESIGN §4.3). EventBridge Scheduler runs it every 15 minutes at
// :00/:15/:30/:45 UTC (infra/modules/scheduler) and passes the run's scheduled time, which stays
// the same when the invocation is retried. Everything here derives from that time, so a retried
// run computes the same window, the same dedupe ids and the same nightly decision.

/** Minutes between runs; must match the schedule expression in infra/modules/scheduler. */
export const SWEEP_INTERVAL_MINUTES = 15;

const INTERVAL_MS = SWEEP_INTERVAL_MINUTES * 60_000;

/**
 * Nightly preview GC (DESIGN §5 step 6): `preview-gc.yml` is dispatched by the first run whose
 * scheduled time falls in [06:15, 07:15) UTC and finds no dispatched run of it since 06:15. The hour
 * gives three more runs a chance if the first one fails. 06:15 is where the interim cron
 * (`17 6 * * *`) ran.
 */
export const NIGHTLY_GC = { hourUtc: 6, minuteUtc: 15, durationMinutes: 60 } as const;

/** Start of the 15-minute window that contains `t` (UTC; epoch-aligned, so :00/:15/:30/:45). */
export function windowStart(t: Date): Date {
  return new Date(Math.floor(t.getTime() / INTERVAL_MS) * INTERVAL_MS);
}

/** `2026-10-23T06:15Z`: a window start in a compact form for ids and logs. */
export function windowLabel(start: Date): string {
  return `${start.toISOString().slice(0, 16)}Z`;
}

/**
 * MessageDeduplicationId of one sweep message: the task and the run's window. A retried run (same
 * scheduled time) sends the same id, so SQS FIFO drops the copy within its 5-minute deduplication
 * interval. Allowed characters and length are within SQS limits (alphanumerics and punctuation,
 * max 128).
 */
export function sweepDedupeId(taskId: number, window: Date): string {
  return `sweep-${taskId}-${windowLabel(windowStart(window))}`;
}

/** The nightly GC window that contains `t`, or null outside it. */
export function nightlyGcWindow(t: Date): { start: Date; end: Date } | null {
  const start = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), NIGHTLY_GC.hourUtc, NIGHTLY_GC.minuteUtc),
  );
  const end = new Date(start.getTime() + NIGHTLY_GC.durationMinutes * 60_000);
  return t >= start && t < end ? { start, end } : null;
}

/**
 * The run's time: `scheduled_time` from the Scheduler input (`<aws.scheduler.scheduled-time>`,
 * e.g. `2026-10-23T06:15:00Z`), else `now` (a manual test invoke). Anything that is not an ISO
 * timestamp within a day of `now` is ignored, so a bad input cannot move the window far.
 */
export function scheduledTimeOf(event: unknown, now: Date): Date {
  if (typeof event === "object" && event !== null && "scheduled_time" in event) {
    const v = (event as { scheduled_time: unknown }).scheduled_time;
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(v)) {
      const t = new Date(v);
      if (!Number.isNaN(t.getTime()) && Math.abs(t.getTime() - now.getTime()) <= 24 * 3600_000) return t;
    }
  }
  return now;
}
