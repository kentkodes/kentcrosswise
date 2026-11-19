import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true });

const toggle = (page: Page) => page.getByRole("button", { name: "X-ray", exact: true });

test("X-ray is off by default", async ({ page }) => {
  await page.goto("/");
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("[data-xray], [data-xray-chip], [data-xray-strip]")).toHaveCount(0);
});

test("turning X-ray on labels the components", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  for (const label of ["Type and theme", "Latest from the log", "Agent activity", "Sign-in link"]) {
    await expect(page.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  }
  await toggle(page).click();
  await expect(page.locator("[data-xray], [data-xray-chip], [data-xray-strip]")).toHaveCount(0);
});

test("a chip opens its card with the keyboard and Escape closes it", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  const chip = page.getByRole("button", { name: /Latest from the log/ });
  await chip.focus();
  const card = page.getByRole("tooltip");
  await expect(card).toBeVisible();
  await expect(card).toContainText("What it does");
  await expect(card).toContainText("Why it was chosen");
  await expect(chip).toHaveAttribute("aria-describedby", /.+/);
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // Focus was not trapped: Tab moves on.
  await page.keyboard.press("Tab");
  await expect(chip).not.toBeFocused();
});

test("X-ray stays on across pages in the session", async ({ page }) => {
  await page.goto("/");
  await toggle(page).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Log" }).click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /Public log/ })).toBeVisible();
});

for (const path of ["/", "/demo", "/office", "/bot"]) {
  test(`${path} at 375px with X-ray on: no sideways scroll, card inside the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto(path);
    await page.evaluate(() => document.fonts.ready);
    await toggle(page).click();
    const chips = page.locator("[data-xray-chip]");
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

for (const width of [320, 375, 1280]) {
  for (const path of ["/", "/demo", "/office", "/bot"]) {
    test(`${path} at ${width}px with X-ray on: chips cover nothing and nothing covers a chip`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(path);
      await page.evaluate(() => document.fonts.ready);
      await toggle(page).click();
      const chips = page.locator("[data-xray-chip]");
      await expect(chips.first()).toBeVisible();
      const count = await chips.count();
      expect(count).toBeGreaterThanOrEqual(3);
      // No chip box intersects a link, button or tab that is not a chip (page coordinates, scroll 0).
      const overlaps = await page.evaluate(() => {
        const rect = (e: Element) => {
          const r = e.getBoundingClientRect();
          return { l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY, w: r.width, h: r.height };
        };
        const chipEls = [...document.querySelectorAll("[data-xray-chip]")];
        const others = [...document.querySelectorAll("a, button, [role=tab]")].filter((e) => !e.hasAttribute("data-xray-chip") && rect(e).w > 0 && rect(e).h > 0);
        const out: string[] = [];
        for (const c of chipEls) {
          const a = rect(c);
          for (const o of others) {
            const b = rect(o);
            if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) out.push(`${c.getAttribute("data-xray-chip")} x ${(o.textContent ?? "").trim().slice(0, 30)}`);
          }
        }
        return out;
      });
      expect(overlaps).toEqual([]);
      // Each chip is the top element at its own centre.
      for (let i = 0; i < count; i++) {
        const chip = chips.nth(i);
        await chip.evaluate((el) => el.scrollIntoView({ block: "center" }));
        const top = await chip.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return hit !== null && el.contains(hit);
        });
        expect(top, `chip ${i} is on top`).toBe(true);
      }
    });
  }
}
