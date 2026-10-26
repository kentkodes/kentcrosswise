import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
async function stepTo(page: Page, kind: string) {
  const room = page.getByTestId("office-room");
  for (let i = 0; i < 14; i++) {
    if (await room.getAttribute("data-event") === kind) return;
    await page.getByRole("button", { name: "Next event", exact: true }).click();
  }
  await expect(room).toHaveAttribute("data-event", kind);
}

test("sample-only scene supports keyboard inspection and files only at merge", async ({ page }) => {
  let feedRequests = 0;
  await page.route("**/api/public/agent-events**", async (route) => { feedRequests++; await route.fulfill({ json: { available: true, events: [] } }); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/preview");
  await expect(page.getByText("Sample animation preview · fictional events", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play animation", exact: true })).toBeEnabled();
  const qa = page.getByRole("button", { name: "QA", exact: true });
  await qa.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("complementary", { name: "Robot inspection" }).getByRole("heading", { name: "QA", exact: true })).toBeVisible();
  await stepTo(page, "approved");
  await expect(page.getByTestId("office-room")).toHaveAttribute("data-filed", "false");
  await stepTo(page, "merged");
  await expect(page.getByTestId("office-room")).toHaveAttribute("data-filed", "true");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByTestId("office-room")).toHaveAttribute("data-event", "task_assigned");
  expect(feedRequests).toBe(0);
});

test("alternate stories show rework, waiting and failures without filing", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/preview");
  for (const [scenario, kind] of [["rework", "changes_requested"], ["tests", "tests_failed"], ["waiting", "waiting_on_owner"], ["failure", "failed"]] as const) {
    await page.getByLabel("Sample story").selectOption(scenario);
    await stepTo(page, kind);
    await expect(page.getByTestId("office-room")).toHaveAttribute("data-filed", "false");
  }
});

test("explicit Play enables full autoplay despite reduced-motion preference", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office/preview");
  const room = page.getByTestId("office-room");
  await expect(room).toHaveAttribute("data-playing", "false");
  await page.getByRole("button", { name: "Play animation", exact: true }).click();
  await expect(room).toHaveAttribute("data-playing", "true");
  await expect(room).toHaveAttribute("data-event", "coding", { timeout: 10000 });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const pausedAt = await room.getAttribute("data-elapsed");
  await page.waitForTimeout(200);
  await expect(room).toHaveAttribute("data-elapsed", pausedAt!);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByLabel("Sample story").selectOption("rework");
  await expect(room).toHaveAttribute("data-playing", "true");
  await expect(room).toHaveAttribute("data-event", "task_assigned");
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(room).toHaveAttribute("data-playing", "true");
});

test("playback pauses offscreen and resumes without catch-up", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/office/preview");
  const room = page.getByTestId("office-room");
  await expect(room).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const pausedAt = await room.getAttribute("data-elapsed");
  await page.waitForTimeout(350);
  await expect(room).toHaveAttribute("data-elapsed", pausedAt!);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(room).toHaveAttribute("data-playing", "true");
  await page.evaluate(() => { document.body.style.paddingBottom = "2000px"; window.scrollTo(0, document.body.scrollHeight); });
  await expect(room).toHaveAttribute("data-playing", "false");
  const offscreenAt = await room.getAttribute("data-elapsed");
  await page.waitForTimeout(500);
  await expect(room).toHaveAttribute("data-elapsed", offscreenAt!);
  await room.scrollIntoViewIfNeeded();
  await expect(room).toHaveAttribute("data-playing", "true");
});

for (const width of [320, 390, 1440]) {
  test(`room and 44px inspection targets fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/office/preview");
    await expect(page.getByTestId("office-room")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const target = await page.getByRole("button", { name: "Developer robot", exact: true }).boundingBox();
    expect(target!.width).toBeGreaterThanOrEqual(44);
    expect(target!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Inspect QA workstation", exact: true }).click();
    await expect(page.getByRole("complementary", { name: "Robot inspection" }).getByRole("heading", { name: "QA", exact: true })).toBeVisible();
  });
}
