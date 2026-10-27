import { test, expect, type Page } from "@playwright/test";
import { bootstrapFixture, REFS } from "../test/fixtures/office-contract";
import type { AvailableOffice } from "../src/office-contract";
import { installPausedClock } from "./support/clock";

function freshBootstrap(): AvailableOffice {
  const e = bootstrapFixture();
  e.observed_at = new Date().toISOString();
  e.snapshot.pause.observed_at = e.observed_at;
  return e;
}
function stateOf(e: AvailableOffice): AvailableOffice {
  return { ...structuredClone(e), events: [], history: { ...structuredClone(e.history), mode: "state", from: null, through: null, cursor: null, replay: null } };
}
async function mocks(page: Page, get: () => AvailableOffice) {
  await page.route("**/api/auth/session", route => route.fulfill({ json: {} }));
  await page.route("**/api/public/agent-events**", route => route.fulfill({ json: { available: false, events: [] } }));
  await page.route("**/api/public/office**", route => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get("mode");
    const e = get();
    if (mode === "bootstrap") return route.fulfill({ json: e });
    if (mode === "state") return route.fulfill({ json: stateOf(e) });
    const value = stateOf(e);
    value.history.mode = "incremental";
    value.history.from = value.history.through = value.history.watermark;
    value.history.cursor = e.history.cursor;
    return route.fulfill({ json: value });
  });
}
const canvasBytes = (page: Page) => page.locator('canvas[aria-label^="Woodland"]').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());

test("malformed office request returns400 and no-store without a database read", async ({ request }) => {
  const result = await request.get("/api/public/office?mode=invalid");
  expect(result.status()).toBe(400);
  expect(result.headers()["cache-control"]).toBe("no-store");
  expect(await result.json()).toEqual({ error: "Invalid office request" });
});

test("replay remains labeled partial, preserves original time and renders no internal refs", async ({ page }) => {
  await mocks(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  await expect(page.getByText("Still view · Play enables motion", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  const log = page.getByRole("region", { name: "Event log" });
  await expect(log.locator("li")).toHaveCount(1);
  await expect(log).toContainText("Private task");
  await expect(log.locator("time")).toHaveAttribute("datetime", "2026-10-25T18:20:00.000Z");
  await expect(page.getByRole("region", { name: "Illustrated transition" })).toContainText("Partial task history");
  expect(await page.locator("body").evaluate(el => /(?:task|exec|event|gen)_[0-9a-f]{8}-/.test(el.innerHTML))).toBe(false);
  await expect(log.getByRole("link")).toHaveCount(0);
});

test("manual Next settles exactly one transition and pause freezes native pixels", async ({ page }) => {
  await mocks(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  await expect(page.getByRole("region", { name: "Event log" }).locator("li")).toHaveCount(1);
  const still = await canvasBytes(page);
  await page.waitForTimeout(1200);
  expect(await canvasBytes(page)).toBe(still);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => canvasBytes(page)).not.toBe(still);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const paused = await canvasBytes(page);
  await page.waitForTimeout(1200);
  expect(await canvasBytes(page)).toBe(paused);
});

test("all QA executions remain inspectable and private task filter uses distinct histories", async ({ page }) => {
  const fixture = freshBootstrap();
  const qa = fixture.snapshot.executions![0]!;
  const other = fixture.snapshot.executions![1]!;
  other.role = "qa"; other.assignment = { station: "qa", seat: null };
  fixture.snapshot.tasks![1]!.role = "qa";
  fixture.history.replay!.events[0]!.role = "qa";
  await mocks(page, () => structuredClone(fixture));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  await page.getByRole("button", { name: "QA", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Agent details" });
  await expect(inspector).toContainText("2 executions reported");
  await inspector.getByRole("button", { name: /entry 2$/ }).click();
  await expect(inspector).toContainText("Private task");
  await page.getByRole("button", { name: "Next event", exact: true }).click();
  await inspector.getByRole("button", { name: "Show task events", exact: true }).click();
  await expect(page.getByRole("region", { name: "Event log" }).locator("li")).toHaveCount(1);
  await page.getByRole("button", { name: "All events", exact: true }).click();
  expect(qa.ref).not.toBe(other.ref);
});

for (const width of [320, 390, 1440]) {
  test(`connected room fits ${width}px without horizontal overflow`, async ({ page }) => {
    await mocks(page, freshBootstrap);
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/office/connected");
    await expect(page.getByRole("status")).toContainText("Replay");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Show annex", exact: true }).click();
    await expect(page.getByRole("img", { name: "Expandable Developer annex", exact: true })).toBeVisible();
  });
}

async function commonMocks(page: Page) {
  await page.route("**/api/auth/session", route => route.fulfill({ json: {} }));
  await page.route("**/api/public/agent-events**", route => route.fulfill({ json: { available: false, events: [] } }));
}
function emptyPage(e: AvailableOffice): AvailableOffice {
  const value = stateOf(e);
  value.history.mode = "incremental";
  value.history.from = value.history.through = value.history.watermark;
  value.history.cursor = e.history.cursor;
  return value;
}

test("privacy withdrawal purges paused inspector and replay labels and rebinds delivery", async ({ page }) => {
  await commonMocks(page);
  let withdrawn = false, rebound = 0;
  const fixture = () => {
    const e = freshBootstrap();
    if (withdrawn) {
      e.privacy_epoch = e.history.privacy_epoch = "3";
      const task = e.snapshot.tasks!.find(t => t.ref === REFS.health)!;
      task.visibility = "private"; task.description = "Private task";
      for (const r of e.snapshot.related_tasks!) if (r.related_task_ref === REFS.health) { r.visibility = "private"; r.description = "Private task"; }
      for (const event of e.history.replay!.events) if (event.task_ref === REFS.health) { event.visibility = "private"; event.description = "Private task"; }
    }
    return e;
  };
  await page.route("**/api/public/office**", route => {
    const url = new URL(route.request().url()), mode = url.searchParams.get("mode");
    const e = fixture();
    if (mode === "bootstrap") return route.fulfill({ json: e });
    const value = mode === "state" ? stateOf(e) : emptyPage(e);
    const oldEpoch = mode === "state" ? url.searchParams.get("privacy_epoch") !== "3" : url.searchParams.get("rebind") !== "true" && rebound === 0;
    if (withdrawn && oldEpoch) {
      value.history.from = mode === "state" ? null : { revision: "10", ordinal: 2 };
      value.history.through = null; value.history.cursor = null; value.history.completeness = "gap";
      value.history.gap = { reason: "privacy_changed", from: value.history.from, through: null, recovery: "rebind" };
      value.history.invalidations = [{ task_ref: REFS.health, kind: "redact" }];
    }
    if (url.searchParams.get("rebind") === "true") rebound++;
    return route.fulfill({ json: value });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installPausedClock(page);
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  await page.getByRole("button", { name: "QA", exact: true }).click();
  const inspector = page.getByRole("complementary", { name: "Agent details" });
  await expect(inspector).toContainText("Add a health endpoint");
  for (let n = 0; n < 3; n++) await page.getByRole("button", { name: "Next event", exact: true }).click();
  await expect(page.getByRole("region", { name: "Event log" })).toContainText("Add a health endpoint");
  withdrawn = true;
  // The first five-second poll observes the privacy gap; the next incremental poll rebinds.
  await page.clock.runFor(5_100);
  await expect(page.getByText(/Descriptions have been updated/)).toBeVisible();
  await page.clock.runFor(5_000);
  await expect.poll(() => rebound).toBeGreaterThan(0);
  await expect(inspector).toContainText("Private task");
  await expect(page.locator("body")).not.toContainText("Add a health endpoint");
  await expect(page.getByRole("region", { name: "Event log" })).toContainText("Private task");
});

test("explicit restart retains a pending transition until the recovery choice", async ({ page }) => {
  await commonMocks(page);
  let delivered = false, recovering = false, bootstraps = 0;
  await page.route("**/api/public/office**", route => {
    const mode = new URL(route.request().url()).searchParams.get("mode");
    const e = freshBootstrap();
    if (mode === "bootstrap") {
      bootstraps++;
      if (recovering) { e.revision = "12"; e.history.watermark = e.history.through = { revision: "12", ordinal: 0 }; }
      return route.fulfill({ json: e });
    }
    if (mode === "state") return route.fulfill({ json: stateOf(e) });
    if (recovering) { e.revision = "12"; e.history.watermark = { revision: "12", ordinal: 0 }; return route.fulfill({ json: emptyPage(e) }); }
    const value = emptyPage(e);
    value.revision = "12"; value.history.watermark = { revision: "12", ordinal: 0 };
    if (!delivered) {
      delivered = true;
      const event = structuredClone(e.history.replay!.events[2]!);
      event.ref = "event_12345678-1234-4123-8123-123456789abc"; event.position = { revision: "11", ordinal: 0 };
      value.events = [event]; value.history.through = event.position; value.history.has_more = true; value.history.completeness = "partial";
    } else {
      value.history.from = { revision: "11", ordinal: 0 }; value.history.through = null; value.history.cursor = null;
      value.history.gap = { reason: "cursor_unavailable", from: value.history.from, through: null, recovery: "restart" }; value.history.completeness = "gap";
    }
    return route.fulfill({ json: value });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installPausedClock(page);
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  await page.clock.runFor(5_100);
  await expect(page.getByRole("status")).toContainText("1 transitions waiting");
  const restart = page.getByRole("button", { name: "Restart and reconcile to current", exact: true });
  await page.clock.runFor(5_000);
  await expect(restart).toBeVisible();
  await expect(page.getByRole("status")).toContainText("1 transitions waiting");
  const beforeRestart = bootstraps;
  recovering = true;
  await restart.click();
  await page.clock.runFor(5_000);
  await expect.poll(() => bootstraps).toBeGreaterThan(beforeRestart);
  await expect(page.getByRole("status")).toContainText("0 transitions waiting");
  await expect(restart).toHaveCount(0);
});

test("offscreen and hidden playback freeze native canvas pixels", async ({ page }) => {
  await mocks(page, freshBootstrap);
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);
  const offscreen = await canvasBytes(page);
  await page.waitForTimeout(600);
  expect(await canvasBytes(page)).toBe(offscreen);
  await page.locator('canvas[aria-label^="Woodland"]').scrollIntoViewIfNeeded();
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(150);
  const hidden = await canvasBytes(page);
  await page.waitForTimeout(600);
  expect(await canvasBytes(page)).toBe(hidden);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
});

const setVisibility = (page: Page, state: "visible" | "hidden") => page.evaluate(value => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
  document.dispatchEvent(new Event("visibilitychange"));
}, state);

test("network lanes poll every five seconds while visible and pause while hidden", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/public/office") requests.push(url.searchParams.get("mode")!);
  });
  await mocks(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installPausedClock(page);
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  // Allow a development-mode remount's aborted bootstrap; only one bootstrap is accepted.
  await expect.poll(() => requests.filter(m => m !== "bootstrap")).toEqual([]);
  const count = (mode: string) => requests.filter(m => m === mode).length;
  await page.clock.runFor(4_900);
  expect([count("incremental"), count("state")]).toEqual([0, 0]);
  await page.clock.runFor(200);
  await expect.poll(() => [count("incremental"), count("state")]).toEqual([1, 1]);
  await page.clock.runFor(5_000);
  await expect.poll(() => [count("incremental"), count("state")]).toEqual([2, 2]);
  await setVisibility(page, "hidden");
  const hiddenAt = requests.length;
  await page.clock.runFor(30_000);
  await page.waitForTimeout(250);
  expect(requests.length).toBe(hiddenAt);
  await setVisibility(page, "visible");
  await expect.poll(() => [count("incremental"), count("state")]).toEqual([3, 3]);
  await page.clock.runFor(4_900);
  await page.waitForTimeout(250);
  expect([count("incremental"), count("state")]).toEqual([3, 3]);
  await page.clock.runFor(200);
  await expect.poll(() => [count("incremental"), count("state")]).toEqual([4, 4]);
});

test("keyboard seat and annex selection inspect their actual assignments", async ({ page }) => {
  const e = freshBootstrap();
  const two = e.snapshot.executions!.find(x => x.ref === REFS.privateTwoRun)!;
  two.role = "developer"; two.assignment = { station: "developer", seat: 2 };
  const twoTask = e.snapshot.tasks!.find(t => t.ref === REFS.privateTwo)!;
  twoTask.role = "developer"; twoTask.visibility = "public"; twoTask.description = "Seat two work";
  const twoEvent = e.history.replay!.events.find(event => event.task_ref === REFS.privateTwo)!;
  twoEvent.role = "developer"; twoEvent.visibility = "public"; twoEvent.description = "Seat two work";
  const annex = e.snapshot.executions!.find(x => x.ref === REFS.docsRun)!;
  annex.role = "developer"; annex.assignment = { station: "annex", seat: 17 };
  e.snapshot.tasks!.find(t => t.ref === REFS.docs)!.role = "developer";
  await mocks(page, () => structuredClone(e));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/connected");
  await expect(page.getByRole("status")).toContainText("Replay");
  const seat = page.getByRole("button", { name: "Developer · seat 2", exact: true });
  await seat.focus(); await page.keyboard.press("Enter");
  const inspector = page.getByRole("complementary", { name: "Agent details" });
  await expect(inspector).toContainText("Seat two work");
  await expect(inspector).not.toContainText("Document the health endpoint");
  await page.getByRole("button", { name: "Developer · annex", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(inspector).toContainText("annex seat 17");
  await expect(inspector).toContainText("Document the health endpoint");
  await expect(inspector).not.toContainText("Seat two work");
});

