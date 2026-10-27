import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { BEATS } from "../src/app/(public)/office/draft/scene";

async function stepTo(page: Page, kind: string) {
  const room = page.getByTestId("connected-room");
  for (let i = 0; i < BEATS.length + 1; i++) {
    if (await room.getAttribute("data-event") === kind) {
      await expect(room).toHaveAttribute("data-settled", "true");
      return;
    }
    await page.getByRole("button", { name: "Next event", exact: true }).click();
  }
  await expect(room).toHaveAttribute("data-event", kind);
}

test("fictional draft supports task descriptions, independent filing, annex and keyboard inspection", async ({ page }) => {
  let feedRequests = 0;
  await page.route("**/api/public/agent-events**", async (route) => { feedRequests++; await route.fulfill({ json: { available: true, events: [] } }); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/draft");
  await expect(page.getByText("Local composition draft · fictional activity", { exact: true })).toBeVisible();
  const room = page.getByTestId("connected-room");
  await expect(room).toHaveAttribute("data-playing", "false");
  await expect(page.getByRole("button", { name: "Play animation", exact: true })).toBeEnabled();
  const seat = page.getByRole("button", { name: "Developer · seat 1", exact: true });
  await seat.focus(); await page.keyboard.press("Enter");
  const details = page.getByRole("complementary", { name: "Agent details" });
  await expect(details.getByText("Add a health endpoint", { exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Show task events", exact: true }).click();
  await expect(page.getByRole("button", { name: "Selected task", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "All events", exact: true }).click();
  await page.getByRole("button", { name: "Developer · annex", exact: true }).click();
  await expect(details.getByText("No sample assignment", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open worker annex", exact: true }).click();
  await expect(page.locator("#worker-annex")).toBeVisible();
  await stepTo(page, "approved");
  await expect(room).toHaveAttribute("data-filed", "0");
  await stepTo(page, "merged");
  await expect(room).toHaveAttribute("data-settled", "true");
  await expect(room).toHaveAttribute("data-filed", "1");
  await expect(page.getByRole("region", { name: "Sample event log" }).getByRole("link")).toHaveCount(0);
  expect(feedRequests).toBe(0);
});

test("explicit motion, pause and restart preserve sequential playback", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/draft");
  const room = page.getByTestId("connected-room");
  await page.getByRole("button", { name: "Play animation", exact: true }).click();
  await expect(room).toHaveAttribute("data-playing", "true");
  await expect(room).toHaveAttribute("data-step", "1", { timeout: 10000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(room).toHaveAttribute("data-playing", "false");
  const step = await room.getAttribute("data-step");
  await page.waitForTimeout(250);
  await expect(room).toHaveAttribute("data-step", step!);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(room).toHaveAttribute("data-step", "0");
});

for (const width of [320, 390, 1440]) {
  test(`draft fits and keeps coworker controls at least 44px tall at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/office/draft");
    await expect(page.getByTestId("connected-room")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const control = await page.getByRole("button", { name: "Developer · annex", exact: true }).boundingBox();
    expect(control!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Developer · annex", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Agent details" }).getByRole("heading", { name: "Developer · annex", exact: true })).toBeVisible();
  });
}
