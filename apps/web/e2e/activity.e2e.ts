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
  await expect(page.getByRole("main").getByRole("link", { name: "Agent office", exact: true })).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none }" });
  await page.screenshot({ path: info.outputPath("home-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  await page.screenshot({ path: info.outputPath("home-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
