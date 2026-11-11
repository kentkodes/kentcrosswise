import { expect, test, type Page } from "@playwright/test";

test("public home renders and links to the demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Watch AI agents build my personal hub." })).toBeVisible();
  await expect(page.getByText(/^Simulated data/)).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Explore the demo", exact: true }).click();
  await expect(page).toHaveURL(/\/demo$/);
});

test("demo page is the app frame with simulated data", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1, name: "The hub, with made-up data" })).toBeVisible();
  await expect(page.getByText("Simulated data", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Today" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Hub sections" });
  await expect(tabs.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");

  await tabs.getByRole("button", { name: "People" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "People" })).toBeVisible();
  // Header row plus the first 8 contacts.
  await expect(page.getByRole("row")).toHaveCount(9);
  await expect(tabs.getByRole("button", { name: "People" })).toHaveAttribute("aria-pressed", "true");

  await tabs.getByRole("button", { name: "Mood" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Mood" })).toBeVisible();
  await expect(page.getByText("Happiness", { exact: true })).toBeVisible();

  await tabs.getByRole("button", { name: "Following" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Following" })).toBeVisible();
  await expect(page.getByText(/in 30 days · demo-/)).toHaveCount(3);

  await tabs.getByRole("button", { name: "Notes" }).click();
  await expect(page.getByRole("heading", { level: 3, name: "To do" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3, name: "Ideas" })).toBeVisible();
});

for (const width of [320, 375]) {
  test(`demo page (${width}px): no sideways page scroll, the tab row scrolls inside itself`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/demo");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const tabs = page.getByRole("navigation", { name: "Hub sections" });
    const overflow = await tabs.evaluate((e) => e.scrollWidth > e.clientWidth);
    expect(overflow, "tabs overflow their own row").toBe(true);
    await tabs.getByRole("button", { name: "Notes" }).scrollIntoViewIfNeeded();
    await tabs.getByRole("button", { name: "Notes" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Notes" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

const PAGES = [
  { path: "/", current: "Home" },
  { path: "/demo", current: "Demo" },
  { path: "/office", current: "Agent office" },
];

async function expectSharedNav(page: Page, current: string, account: "Sign in" | "Your hub") {
  const nav = page.getByRole("navigation", { name: "Main" });
  const links = nav.getByRole("link");
  await expect(links).toHaveCount(4);
  await expect(links.nth(0)).toHaveText("Home");
  await expect(links.nth(1)).toHaveText("Demo");
  await expect(links.nth(2)).toHaveText("Agent office");
  // Resolved in the browser after mount (AccountLink); both labels are in the DOM, one hidden.
  await expect(links.nth(3)).toHaveAccessibleName(account);
  await expect(links.nth(3)).toHaveAttribute("href", account === "Your hub" ? "/hub" : "/api/auth/signin");
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

  test("the account link swaps to Your hub in place, without moving", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/auth/session", async (route) => {
      await held;
      await route.fulfill({ json: { user: { name: "Someone" }, expires: "2999-01-01T00:00:00.000Z" } });
    });
    await page.goto("/demo");
    const account = page.getByRole("navigation", { name: "Main" }).getByRole("link").nth(3);
    await expect(account).toHaveAccessibleName("Sign in");
    const before = await account.boundingBox();
    release();
    await expect(account).toHaveAccessibleName("Your hub");
    await expect(account).toHaveAttribute("href", "/hub");
    expect(await account.boundingBox()).toEqual(before);
  });

  test("Sign in stays when the session check fails", async ({ page }) => {
    await page.route("**/api/auth/session", (route) => route.abort());
    await page.goto("/office");
    await expectSharedNav(page, "Agent office", "Sign in");
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
