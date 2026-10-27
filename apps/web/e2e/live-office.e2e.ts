import { expect, test } from "@playwright/test";
import { installPausedClock } from "./support/clock";
const event = (id: number, type: string, agent = "developer") => ({ id, ts: "2026-10-26T00:00:00.000Z", agent, type, title: "Private task" });

test("the canvas leaving the viewport suspends playback while its legend remains visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/public/agent-events*", route => route.fulfill({ json: { available: true, events: [event(1, "coding")] } }));
  await page.goto("/office");
  const room = page.getByTestId("live-office-room");
  await expect(room).toHaveAttribute("data-playing", "true");
  await page.evaluate(() => {
    document.body.style.paddingBottom = "2000px";
    const rect = document.querySelector('[data-testid="live-office-room"]')!.getBoundingClientRect();
    window.scrollBy(0, rect.bottom + 1);
  });
  await expect(room).toHaveAttribute("data-playing", "false");
  const elapsed = await room.getAttribute("data-elapsed");
  await page.waitForTimeout(250);
  await expect(room).toHaveAttribute("data-elapsed", elapsed!);
  await expect(page.getByRole("button", { name: "Developer", exact: true })).toBeInViewport();
});

test("full autoplay can be chosen on a reduced-motion phone and retains sanitized event text", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/public/agent-events*", route => route.fulfill({ json: { available: true, events: [event(1, "coding"), event(2, "approved", "qa")] } }));
  await installPausedClock(page);
  await page.goto("/office");
  const room = page.getByTestId("live-office-room");
  await expect(room).toHaveAttribute("data-playing", "false");
  await expect(page.getByRole("button", { name: "Play animation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Play animation", exact: true }).click();
  await room.scrollIntoViewIfNeeded();
  await expect(room).toHaveAttribute("data-playing", "true");
  await page.clock.runFor(5_200);
  await expect(page.getByTestId("activity-playback").locator("[data-event-id]")).toHaveAttribute("data-event-id", "2");
  await expect(room).toHaveAttribute("data-filed", "false");
  await expect(page.getByTestId("agent-events").locator("li").first()).toContainText("Private task");
  await page.getByRole("button", { name: "QA robot", exact: true }).click();
  await expect(page.getByRole("button", { name: "QA robot", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("one recorded merge completes filing and restarts its replay without inheriting filed work", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/public/agent-events*", route => route.fulfill({ json: { available: true, events: [event(1, "merged", "orchestrator")] } }));
  await installPausedClock(page);
  await page.goto("/office");
  const room = page.getByTestId("live-office-room");
  await room.scrollIntoViewIfNeeded();
  await expect(room).toHaveAttribute("data-playing", "true");
  await page.clock.runFor(6_200);
  await expect(room).toHaveAttribute("data-filed", "true");
  await page.clock.runFor(1_200);
  await expect(room).toHaveAttribute("data-cycle", "1");
  await expect(room).toHaveAttribute("data-phase", "return");
  await expect(room).toHaveAttribute("data-filed", "false");
});

test("a newly received event preempts quiet replay without assigning unknown agents a robot", async ({ page }) => {
  let fresh = false;
  await page.route("**/api/public/agent-events*", route => route.fulfill({ json: { available: true, events: fresh ? [event(2, "coding", "docs")] : [event(1, "pr_opened")] } }));
  await installPausedClock(page);
  await page.goto("/office");
  const room = page.getByTestId("live-office-room");
  await room.scrollIntoViewIfNeeded();
  await expect(room).toHaveAttribute("data-playing", "true");
  await page.clock.runFor(3_000);
  fresh = true;
  await page.clock.runFor(2_200);
  await expect(page.locator("#playback-title")).toHaveText("Live feed · new event");
  await expect(room).toHaveAttribute("data-event", "coding");
  await expect(room).toHaveAttribute("data-phase", "return");
  await expect(room).toHaveAttribute("data-filed", "false");
  await expect(page.getByText(/This event has no robot animation yet/)).toBeVisible();
});
