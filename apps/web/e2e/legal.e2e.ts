import { expect, test } from "@playwright/test";

const PAGES = [
  { path: "/terms", title: "Terms | Kentcrosswise", h1: "Terms", link: "Terms", updated: "19 November 2026" },
  { path: "/privacy", title: "Privacy | Kentcrosswise", h1: "Privacy", link: "Privacy", updated: "19 November 2026" },
];

for (const p of PAGES) {
  test(`${p.path} is public with a title, headings and the date`, async ({ page }) => {
    const response = await page.goto(p.path);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(p.title);
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: p.h1, exact: true })).toBeVisible();
    expect(await main.getByRole("heading", { level: 2 }).count()).toBeGreaterThan(3);
    await expect(main.getByText(`Last updated: ${p.updated}`, { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "open an issue" }))
      .toHaveAttribute("href", "https://github.com/kentkodes/kentcrosswise/issues/new");
  });

  test(`footer on / links to ${p.path}`, async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: p.link, exact: true });
    await expect(link).toHaveAttribute("href", p.path);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`${p.path}$`));
  });

  for (const width of [375, 320]) {
    test(`${p.path} has no horizontal scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(p.path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const link = page.getByRole("main").getByRole("link").first();
      await link.focus();
      await expect(link).toBeFocused();
    });
  }
}

test("privacy links the Google Privacy Policy and names no other service", async ({ page }) => {
  await page.goto("/privacy");
  const main = page.getByRole("main");
  await expect(main.getByRole("link", { name: "Google Privacy Policy" }).first())
    .toHaveAttribute("href", "https://policies.google.com/privacy");
  expect(await main.innerText()).not.toMatch(/YouTube|Instagram|TikTok/);
});
