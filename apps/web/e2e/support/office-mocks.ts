// Route mocks for /api/public/office, shared by the Room and Board e2e specs. The envelopes are the fictional
// fixtures in test/fixtures/office-contract.ts; each call returns a fresh copy the test may change.
import type { Page } from "@playwright/test";
import { bootstrapFixture } from "../../test/fixtures/office-contract";
import type { AvailableOffice } from "../../src/office-contract";

/** The bootstrap fixture with observed times set to now, so freshness is not stale. */
export function freshBootstrap(): AvailableOffice {
  const e = bootstrapFixture();
  e.observed_at = new Date().toISOString();
  e.snapshot.pause.observed_at = e.observed_at;
  return e;
}

/** A state response: the same snapshot with no events. */
export function stateOf(e: AvailableOffice): AvailableOffice {
  return { ...structuredClone(e), events: [], history: { ...structuredClone(e.history), mode: "state", from: null, through: null, cursor: null, replay: null } };
}

/** An incremental response with no new events and the watermark as its cursor. */
export function emptyPage(e: AvailableOffice): AvailableOffice {
  const value = stateOf(e);
  value.history.mode = "incremental";
  value.history.from = value.history.through = value.history.watermark;
  value.history.cursor = e.history.cursor;
  return value;
}

/** Mocks the session, the legacy feed and /api/public/office (bootstrap, state and incremental modes). */
export async function mockOfficeFeed(page: Page, get: () => AvailableOffice) {
  await page.route("**/api/auth/session", route => route.fulfill({ json: {} }));
  await page.route("**/api/public/agent-events**", route => route.fulfill({ json: { available: false, events: [] } }));
  await page.route("**/api/public/office**", route => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get("mode");
    const e = get();
    if (mode === "bootstrap") return route.fulfill({ json: e });
    if (mode === "state") return route.fulfill({ json: stateOf(e) });
    return route.fulfill({ json: emptyPage(e) });
  });
}
