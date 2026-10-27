import { expect, test } from "@playwright/test";

test("bot contact page is public, describes current status and links to public issue reporting", async ({ page }) => {
  const response = await page.goto("/bot");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/bot$/);
  await expect(page).toHaveTitle("KentcrosswiseBot | Kentcrosswise");
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: "KentcrosswiseBot", exact: true })).toBeVisible();
  await expect(main.getByText("In development. Automated discovery is not enabled.", { exact: true })).toBeVisible();
  await expect(main.getByText("KentcrosswiseBot/1.0 (+https://kentcrosswise.com/bot)", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Report a bot issue", exact: true }))
    .toHaveAttribute("href", "https://github.com/kentkodes/kentcrosswise/issues/new");
  await expect(main.getByText(/GitHub sign-in required\. Reports are public/)).toBeVisible();
  // The page is directly addressable without adding another global navigation item.
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link")).toHaveCount(4);
});

for (const width of [1440, 320]) {
  test(`bot contact page remains readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/bot");
    const report = page.getByRole("link", { name: "Report a bot issue", exact: true });
    await expect(report).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await report.focus();
    await expect(report).toBeFocused();
  });
}
