import type { Page } from "@playwright/test";

// Install the fake clock and pause it slightly ahead of real time. `clock.install({ time })` lets the
// fake clock keep ticking with real time, so pausing at the install time itself throws "Cannot
// fast-forward to the past" whenever any real time elapses between the two calls (seen under load).
// The pause target is computed when pauseAt is called, plus a margin for the call's own latency.
// Nothing on the page runs yet (call before goto), so the short fast-forward fires no app timers.
export async function installPausedClock(page: Page, marginMs = 2_000): Promise<Date> {
  await page.clock.install({ time: new Date() });
  const pausedAt = new Date(Date.now() + marginMs);
  await page.clock.pauseAt(pausedAt);
  return pausedAt;
}
