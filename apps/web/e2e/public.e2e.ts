import { expect, test, type Page } from "@playwright/test";

// PL5: the home page leads with the public log; /demo is the log (default tab) and the Essays tab. Record data is
// served by the real API on previews (no published records there), so these tests route a fixed synthetic reply.
const LOG = { available: true, label: "Tasks published automatically after sanitization; some records withheld for privacy/security", counts: { published: 1, withheld: 2, awaitingReview: 3 }, records: [{ id: "00000000-0000-4000-8000-000000000001", capturedHour: "2026-11-18T14:00:00.000Z", kind: "todo", text: "Book the [place] table for [Person 1]", steps: [{ step: "captured", hour: "2026-11-18T14:00:00.000Z" }, { step: "route_failed", hour: "2026-11-18T14:00:00.000Z", code: "provider_error", attempt: 1 }, { step: "routed", hour: "2026-11-18T14:00:00.000Z", kind: "idea", by: "model", confidence: 0.91, model: "deepseek-flash" }, { step: "derived", hour: "2026-11-18T14:00:00.000Z", kind: "idea" }, { step: "corrected", hour: "2026-11-18T15:00:00.000Z", from: "idea", to: "todo" }, { step: "derived", hour: "2026-11-18T15:00:00.000Z", kind: "todo", moved_from: "idea" }], checks: [{ check: "derived_rows", result: "pass" }, { check: "usage_recorded", result: "fail" }, { check: "failures_resolved", result: "pass" }], checksVersion: 1 }], accuracy: { routes: [{ model: "deepseek-flash", confirmed: 3, corrected: 1 }], links: { confirmed: 1, changed: 1 }, calendar: { added: 1, dismissed: 1 } } };
const routeLog = (page: Page) => page.route("**/api/public/log", (route) => route.fulfill({ json: LOG }));

test("public home leads with the log and links to it", async ({ page }) => {
  await routeLog(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "A personal helper you can inspect." })).toBeVisible();
  const latest = page.getByRole("region", { name: "Latest from the log" });
  await expect(latest.getByText("Book the [place] table for [Person 1]")).toBeVisible();
  await expect(latest.getByText("Corrected: Idea → Todo · Recovered after 1 failed attempt · 1 check failed")).toBeVisible();
  await expect(page.getByText(/Simulated data/)).toHaveCount(0);
  await page.getByRole("main").getByRole("link", { name: "Read the log", exact: true }).first().click();
  await expect(page).toHaveURL(/\/demo$/);
});

test("the log tab shows counts, the label, the record and its evidence", async ({ page }) => {
  await routeLog(page);
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1, name: "The log" })).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Sections" });
  await expect(tabs.getByRole("button", { name: "Log" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("log-counts")).toHaveText("1 published · 2 withheld · 3 awaiting review");
  await expect(page.getByText("Tasks published automatically after sanitization; some records withheld for privacy/security")).toBeVisible();
  const record = page.getByRole("list", { name: "Published entries" }).getByRole("listitem").first();
  await expect(record.getByText("Book the [place] table for [Person 1]")).toBeVisible();
  await record.getByText(/^Evidence/).click();
  await expect(record.getByText("Filing failed: the model provider returned an error (attempt 1)")).toBeVisible();
  await expect(record.getByText("The model filed it as idea (confidence 0.91, deepseek-flash)")).toBeVisible();
  await expect(record.getByText("I corrected it from idea to todo")).toBeVisible();
  await expect(record.getByText("Moved the record from idea to todo")).toBeVisible();
  await expect(record.getByText("Checks · list v1")).toBeVisible();
  await expect(record.getByRole("list", { name: "Checks" }).getByRole("listitem")).toHaveText([
    "Passed: The saved records match the kind",
    "Failed: Every model call has a usage record",
    "Passed: Every failed step was followed by a success",
  ]);
  const accuracy = page.getByRole("region", { name: "Accuracy" });
  await expect(accuracy.getByText("Model filings confirmed: 3 of 4 (75%), deepseek-flash")).toBeVisible();
  await expect(accuracy.getByText("Calendar suggestions added: 1 of 2")).toBeVisible();
  await expect(accuracy.getByText("Contact links confirmed: 1 of 2 (50%)")).toBeVisible();
});

test("the log tab says so when nothing is published, and when the log is unavailable", async ({ page }) => {
  await page.route("**/api/public/log", (route) =>
    route.fulfill({ json: { ...LOG, counts: { published: 0, withheld: 0, awaitingReview: 0 }, records: [] } }),
  );
  await page.goto("/demo");
  await expect(page.getByText("Nothing published yet.")).toBeVisible();
  await page.unroute("**/api/public/log");
  await page.route("**/api/public/log", (route) => route.fulfill({ status: 500, body: "" }));
  await page.reload();
  await expect(page.getByText("The log is unavailable right now.")).toBeVisible();
});

for (const width of [320, 375]) {
  test(`log page (${width}px): no sideways page scroll with the evidence open`, async ({ page }) => {
    await routeLog(page);
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/demo");
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole("list", { name: "Published entries" }).getByText(/^Evidence/).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.goto("/");
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}

const PAGES = [
  { path: "/", current: "Home" },
  { path: "/demo", current: "Log" },
  { path: "/office", current: "Agent office" },
];

async function expectSharedNav(page: Page, current: string, account: "Sign in" | "Your hub") {
  const nav = page.getByRole("navigation", { name: "Main" });
  const links = nav.getByRole("link");
  await expect(links).toHaveCount(4);
  await expect(links.nth(0)).toHaveText("Home");
  await expect(links.nth(1)).toHaveText("Log");
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
    await nav.getByRole("link", { name: "Log" }).click();
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

test("demo Essays tab: feed, recommended line, reader panel and local rating", async ({ page }) => {
  await page.goto("/demo");
  const tabs = page.getByRole("navigation", { name: "Sections" });
  await tabs.getByRole("button", { name: "Essays" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Essays" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Essay feed" }).getByRole("listitem")).toHaveCount(6);
  await expect(page.getByText("Because you liked Fenimore Cooper's Literary Offences")).toBeVisible();
  await page.getByRole("list", { name: "Essay feed" }).getByRole("button", { name: "The Whistle" }).click();
  const reader = page.getByRole("article");
  await expect(reader.getByRole("heading", { level: 3, name: "The Whistle" })).toBeVisible();
  await expect(reader.getByRole("link", { name: "Read it at Project Gutenberg" })).toHaveAttribute(
    "href",
    "https://www.gutenberg.org/ebooks/78663",
  );
  const save = reader.getByRole("button", { name: "Save rating" });
  await expect(save).toBeDisabled();
  await reader.getByLabel("4", { exact: true }).check();
  await reader.getByLabel("Humor", { exact: true }).check();
  await reader.getByLabel("Right", { exact: true }).check();
  await save.click();
  await expect(reader.getByRole("status")).toContainText("Saved on this page");
  await page.reload();
  await tabs.getByRole("button", { name: "Essays" }).click();
  await expect(page.getByRole("article")).toHaveCount(0);
});

for (const width of [320, 375]) {
  test(`demo Essays tab (${width}px): reader and rating fit without sideways page scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await page.goto("/demo");
    const tabs = page.getByRole("navigation", { name: "Sections" });
    await tabs.getByRole("button", { name: "Essays" }).scrollIntoViewIfNeeded();
    await tabs.getByRole("button", { name: "Essays" }).click();
    await page.getByRole("list", { name: "Essay feed" }).getByRole("button", { name: "Walking" }).click();
    await expect(page.getByRole("article")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  });
}
