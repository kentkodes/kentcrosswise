import { expect, test, type Page } from "@playwright/test";

test("public home renders and links to the demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /A little space\s*for your everyday\./ })).toBeVisible();
  await expect(page.getByText(/^Simulated data/)).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Explore the demo", exact: true }).click();
  await expect(page).toHaveURL(/\/demo$/);
});

test("demo page shows simulated data", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1, name: "Demo" })).toBeVisible();
  await expect(page.getByText("Everything on this page is simulated")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
});

const PAGES = [
  { path: "/", current: "Home" },
  { path: "/demo", current: "Demo" },
  { path: "/office", current: "Agent office" },
];

async function expectSharedNav(page: Page, current: string, account: "Sign in" | "Your hub") {
  const nav = page.getByRole("navigation", { name: "Main" });
  const links = nav.getByRole("link");
  await expect(links).toHaveText(["Home", "Demo", "Agent office", account]);
  await expect(nav.getByRole("link", { name: current, exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
}

test.describe("shared navigation", () => {
  for (const { path, current } of PAGES) {
    test(`${path} has the shared nav with ${current} current`, async ({ page }) => {
      await page.goto(path);
      await expectSharedNav(page, current, "Sign in");
      await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sign in" })).toHaveAttribute(
        "href",
        "/api/auth/signin",
      );
    });
  }

  test("the nav moves between the public pages", async ({ page }) => {
    await page.goto("/demo");
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("link", { name: "Agent office" }).click();
    await expect(page).toHaveURL(/\/office$/);
    await nav.getByRole("link", { name: "Home" }).click();
    await expect(page).toHaveURL(/\/$/);
    await nav.getByRole("link", { name: "Demo" }).click();
    await expect(page).toHaveURL(/\/demo$/);
  });

  test("the day/night toggle is on the home page only", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("group", { name: "Scene light" })).toBeVisible();
    for (const path of ["/demo", "/office"]) {
      await page.goto(path);
      await expect(page.getByRole("group", { name: "Scene light" })).toHaveCount(0);
    }
  });

  for (const width of [320, 375]) {
    test(`phones (${width}px): one row of links, no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      for (const { path } of PAGES) {
        await page.goto(path);
        await page.evaluate(() => document.fonts.ready);
        const links = page.getByRole("navigation", { name: "Main" }).getByRole("link");
        await expect(links).toHaveCount(4);
        const boxes = await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
        const mid = boxes.map((b) => b.y + b.height / 2);
        expect(Math.max(...mid) - Math.min(...mid), `${path}: links on one row`).toBeLessThan(4);
        expect(Math.max(...boxes.map((b) => b.right)), `${path}: links inside the viewport`).toBeLessThanOrEqual(width);
        const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scroll, `${path}: no horizontal scroll`).toBeLessThanOrEqual(width);
      }
    });
  }
});

test.describe("shared navigation, signed in", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  test("Sign in becomes Your hub on every public page", async ({ page }) => {
    await page.goto("/api/auth/signin");
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    for (const { path, current } of PAGES) {
      await page.goto(path);
      await expectSharedNav(page, current, "Your hub");
    }
    // The longer "Your hub" still fits the phone row inside the page gutters at 320px.
    await page.setViewportSize({ width: 320, height: 740 });
    await page.goto("/demo");
    await page.evaluate(() => document.fonts.ready);
    const right = await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Your hub" })
      .evaluate((e) => e.getBoundingClientRect().right);
    expect(right).toBeLessThanOrEqual(320 - 12);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Your hub" }).click();
    await expect(page).toHaveURL(/\/hub$/);
    await expect(page.getByRole("heading", { level: 1, name: "Hub" })).toBeVisible();
  });
});
