import { expect, test } from "@playwright/test";

const events = Array.from({ length: 25 }, (_, index) => ({
  id: index + 1, ts: `2026-10-24T12:${String(index).padStart(2, "0")}:00.000Z`,
  agent: "developer", type: "task_completed", title: `Recorded test task ${index + 1}`,
}));

test("homepage uses the three latest public events and the activity entrance", async ({ page }, info) => {
  await page.route("**/api/public/agent-events*", (route) => route.fulfill({ json: { available: true, events } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const recent = page.getByRole("region", { name: "Recent activity" });
  await expect(recent.locator("li")).toHaveCount(3);
  await expect(recent.locator("li").first()).toContainText("Recorded test task 25");
  await expect(recent.locator("time").first()).toHaveAttribute("datetime", events[24]!.ts);
  await expect(page.getByRole("link", { name: "View agent activity" })).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none }" });
  await page.screenshot({ path: info.outputPath("home-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({ path: info.outputPath("home-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("quiet replay, pause, manual next and newly received event priority", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  let releaseNew = false;
  await page.route("**/api/public/agent-events*", (route) => route.fulfill({ json: {
    available: true, events: releaseNew ? [{ ...events[0], id: 26, title: "Newly recorded test task" }] : events,
  } }));
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.goto("/office");
  const playback = page.getByTestId("activity-playback");
  await expect(playback.locator("#playback-title")).toHaveText("Activity replay");
  await expect(playback.locator("[data-event-id]")).toHaveAttribute("data-event-id", "6");
  await expect(playback).toContainText("Replaying 20 recorded events");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.clock.runFor(4_100);
  await expect(playback.locator("[data-event-id]")).toHaveAttribute("data-event-id", "6");
  await page.getByRole("button", { name: "Next event" }).click();
  await expect(playback.locator("[data-event-id]")).toHaveAttribute("data-event-id", "7");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  releaseNew = true;
  await page.clock.runFor(1_100);
  await expect(playback.locator("#playback-title")).toHaveText("Live feed · new event");
  await expect(playback).toContainText("Newly recorded test task");
  await page.clock.runFor(5_200);
  await expect(playback.locator("#playback-title")).toHaveText("Activity replay");
  await expect(page.getByTestId("agent-events").locator("li")).toHaveCount(26);
  await page.addStyleTag({ content: "nextjs-portal { display: none }" });
  await page.screenshot({ path: info.outputPath("office-desktop.png") });
});

test("reduced motion stays manual and mobile playback retains original timestamps", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/public/agent-events*", (route) => route.fulfill({ json: { available: true, events: events.slice(0, 2) } }));
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.goto("/office");
  const playback = page.getByTestId("activity-playback");
  await expect(page.getByRole("button", { name: "Play animation", exact: true })).toBeEnabled();
  await expect(playback.locator("[data-event-id]")).toHaveAttribute("data-event-id", "1");
  await page.clock.runFor(12_000);
  await expect(playback.locator("[data-event-id]")).toHaveAttribute("data-event-id", "1");
  await page.getByRole("button", { name: "Next event" }).click();
  await expect(playback.locator("time")).toHaveAttribute("datetime", events[1]!.ts);
  await page.addStyleTag({ content: "nextjs-portal { display: none }" });
  await page.screenshot({ path: info.outputPath("office-mobile-reduced.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("an empty or unavailable feed never supplies invented events", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/public/agent-events*", (route) => route.fulfill({ json: { available: true, events: [] } }));
  await page.goto("/office");
  await expect(page.getByText("No public agent events yet.")).toBeVisible();
  await expect(page.getByText(/^Real public activity/)).toBeVisible();
  const emptyStatus = await page.getByText("No public agent events yet.").boundingBox();
  expect(emptyStatus!.y + emptyStatus!.height).toBeLessThan(844);
  await expect(page.getByRole("button", { name: "Next event" })).toBeDisabled();
  await page.addStyleTag({ content: "nextjs-portal { display: none }" });
  await page.screenshot({ path: info.outputPath("office-empty.png") });
  await page.unroute("**/api/public/agent-events*");
  await page.route("**/api/public/agent-events*", (route) => route.abort());
  await page.reload();
  await expect(page.getByText("No cached events to replay.")).toBeVisible();
  await expect(page.getByTestId("agent-events").locator("li")).toHaveCount(0);
});

test("autoplay pauses while hidden or offscreen and resumes when visible", async ({ page }) => {
  await page.route("**/api/public/agent-events*", (route) => route.fulfill({ json: { available: true, events } }));
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.goto("/office");
  const current = page.getByTestId("activity-playback").locator("[data-event-id]");
  await expect(current).toHaveAttribute("data-event-id", "6");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(8_100);
  await expect(current).toHaveAttribute("data-event-id", "6");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.scrollTo(0, document.body.scrollHeight);
  });
  await expect(page.getByTestId("activity-playback")).not.toBeInViewport();
  await page.clock.runFor(8_100);
  await expect(current).toHaveAttribute("data-event-id", "6");
  await page.getByTestId("live-office-room").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("activity-playback")).toHaveAttribute("data-playing", "true");
  await page.clock.runFor(5_200);
  await expect(current).toHaveAttribute("data-event-id", "7");
});

test("cached events remain explicitly labeled when polling fails", async ({ page }) => {
  let fail = false;
  await page.route("**/api/public/agent-events*", (route) => !fail
    ? route.fulfill({ json: { available: true, events: events.slice(0, 2) } }) : route.abort());
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.goto("/office");
  await expect(page.getByTestId("agent-events").locator("li")).toHaveCount(2);
  fail = true;
  await page.clock.runFor(5_100);
  await expect(page.getByRole("heading", { name: "Activity replay · cached" })).toBeVisible();
  await expect(page.getByText(/Showing cached events/)).toBeVisible();
});
