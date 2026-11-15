import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true });

const toggle = (page: Page) => page.getByRole("button", { name: "X-ray", exact: true });

test("X-ray is off by default", async ({ page }) => {
  await page.goto("/");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-xray]")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Type and theme/ })).toHaveCount(0);
});

test("turning X-ray on labels the components", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  for (const label of ["Type and theme", "Hub preview", "Agent activity", "Sign-in link"]) {
    await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }
  await toggle(page).click();
  await expect(page.locator("[data-xray]")).toHaveCount(0);
});

test("a chip opens its card with the keyboard and Escape closes it", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  const chip = page.getByRole("button", { name: /Hub preview/ });
  await chip.focus();
  const card = page.getByRole("tooltip");
  await expect(card).toBeVisible();
  await expect(card).toContainText("What it does");
  await expect(card).toContainText("Why it was chosen");
  await expect(chip).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // Focus was not trapped: Tab moves on.
  await page.keyboard.press("Tab");
  await expect(chip).not.toBeFocused();
});

test("X-ray stays on across pages in the session", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Demo" }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Demo hub/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Simulated data @kcw/ })).toBeVisible();
});

for (const path of ["/", "/demo", "/office", "/bot"]) {
  test(`${path} at 375px with X-ray on: no sideways scroll, card inside the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    await toggle(page).click();
    const chips = page.locator("[data-xray] > button");
    await expect(chips.first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Tap the last visible chip on the page; its card must fit.
    const chip = chips.last();
    await chip.scrollIntoViewIfNeeded();
    await chip.tap();
    const card = page.getByRole("tooltip");
    await expect(card).toBeVisible();
    const box = await card.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
}
