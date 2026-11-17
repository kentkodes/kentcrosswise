// H2: the hub capture box. H3: the route picker behind each row's closed "Change route" disclosure. AR7: the
// Unresolved region lists every entry that is not routed or needs the owner. The database is shared with other
// tests: every item carries a unique marker and every assertion is scoped to rows with it. Previews (and the
// local run) have the synthetic seed, which already holds some entries. Routing is off in these runs (no models
// secret), so a new entry shows "Waiting for router" and has no "Route again" button.
import { expect, test, type Page } from "@playwright/test";

test("hub redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/hub");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Hub" })).toHaveCount(0);
});

test.describe("as the preview owner", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  async function signIn(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto(path);
  }

  // The capture form's Save button (rows have Save buttons too, so scope to the capture region).
  const captureSave = (page: Page) => page.getByTestId("capture").getByRole("button", { name: "Save" });

  test("saves an entry as pending, and an all-whitespace one creates no row", async ({ page }) => {
    await signIn(page, "/hub");
    await expect(page.getByRole("heading", { level: 1, name: "Hub" })).toBeVisible();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const unresolved = page.getByTestId("unresolved").locator("li");

    await page.getByLabel("Capture", { exact: true }).fill(`e2e capture ${stamp}`);
    await captureSave(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    // The redirect leaves the box empty, and the new entry is listed as unresolved, pending.
    await expect(page.getByLabel("Capture", { exact: true })).toHaveValue("");
    const mine = unresolved.filter({ hasText: `e2e capture ${stamp}` });
    await expect(mine).toHaveCount(1);
    await expect(mine.locator('[data-field="status"]')).toHaveText("Waiting for router");

    // Whitespace passes the browser's required check, so the server refuses it and nothing is stored.
    await page.getByLabel("Capture", { exact: true }).fill("   \n  ");
    await captureSave(page).click();
    // Scoped: Next's own route announcer is also role=alert.
    await expect(page.getByRole("alert").filter({ hasText: "Nothing to save" })).toHaveCount(1);
    await expect(unresolved.filter({ hasText: `e2e capture ${stamp}` })).toHaveCount(1);
  });

  test("Ctrl+Enter saves, and the page fits a 320px phone", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await signIn(page, "/hub");
    const box = page.getByLabel("Capture", { exact: true });
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await box.fill(`e2e keyboard ${stamp}`);
    await box.press("Enter"); // plain Enter is a newline, not a submit
    await expect(page.getByRole("status")).toHaveCount(0);
    await box.press("Control+Enter");
    await expect(page.getByRole("status")).toHaveText("Saved");
    await expect(page.getByTestId("unresolved").locator("li").filter({ hasText: `e2e keyboard ${stamp}` })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await captureSave(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("the Unresolved region fits a 375px phone and its route picker is usable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, "/hub");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const text = `e2e phone ${stamp}`;
    await page.getByLabel("Capture", { exact: true }).fill(text);
    await captureSave(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    const row = page.getByTestId("unresolved").locator("li").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await row.getByText("Change route", { exact: true }).click();
    await expect(row.getByRole("combobox")).toBeVisible();
    await expect(row.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.getByRole("combobox").selectOption({ label: "Todo" });
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Todo.");
    await expect(page.getByTestId("unresolved").locator("li").filter({ hasText: text })).toHaveCount(0);
  });

  test("a pending entry is routed by hand: the row shows the new label, and no Route again while routing is off", async ({ page }) => {
    await signIn(page, "/hub");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const text = `e2e reassign ${stamp}`;
    await page.getByLabel("Capture", { exact: true }).fill(text);
    await captureSave(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved");

    const row = page.getByTestId("unresolved").locator("li").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-field="status"]')).toHaveText("Waiting for router");
    await row.getByText("Change route", { exact: true }).click();
    await expect(row.getByRole("button", { name: "Route again" })).toHaveCount(0);

    await row.getByRole("combobox").selectOption({ label: "Idea" });
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Idea.");
    // The route is set, so the row leaves the Unresolved region.
    await expect(page.getByTestId("unresolved").locator("li").filter({ hasText: text })).toHaveCount(0);
  });

  test("a row's closed Change route disclosure saves a different route", async ({ page }) => {
    await signIn(page, "/hub");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const text = `e2e change route ${stamp}`;
    await page.getByLabel("Capture", { exact: true }).fill(text);
    await captureSave(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved");

    // The route form starts hidden behind the row's disclosure.
    const row = page.getByTestId("unresolved").locator("li").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    const disclosure = row.locator("details");
    await expect(disclosure).toHaveJSProperty("open", false);
    await expect(disclosure.locator("summary")).toHaveText("Change route");
    await row.getByText("Change route", { exact: true }).click();
    await expect(disclosure).toHaveJSProperty("open", true);

    // Route it once, then change the route from the Recent row.
    await row.getByRole("combobox").selectOption({ label: "Todo" });
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Todo.");
    const recent = page.getByTestId("recent").locator("li").filter({ hasText: text });
    await expect(recent).toHaveCount(1);
    await expect(recent.locator('[data-field="status"]')).toHaveText("Todo");

    await recent.getByText("Change route", { exact: true }).click();
    await recent.getByRole("combobox").selectOption({ label: "Idea" });
    await recent.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Idea.");

    // The reloaded row shows the new route, and the disclosure has it selected.
    const updated = page.getByTestId("recent").locator("li").filter({ hasText: text });
    await expect(updated.locator('[data-field="status"]')).toHaveText("Idea");
    await updated.getByText("Change route", { exact: true }).click();
    await expect(updated.getByRole("combobox")).toHaveValue("idea");
  });

  test("Unresolved lists a row that needs the owner and links to the routing inbox (local seed)", async ({ page }) => {
    // The routing seed (e2e/support/local-db.ts) exists only in the local run.
    test.skip(!!process.env.BASE_URL, "the routing seed is local only");
    await signIn(page, "/hub");
    await expect(page.getByRole("heading", { name: "Unresolved" })).toBeVisible();
    const row = page.getByTestId("unresolved").locator("li").filter({ hasText: "e2e route seed two" });
    await expect(row).toHaveCount(1);
    const link = row.getByRole("link", { name: "Needs you" });
    await expect(link).toHaveAttribute("href", "/inbox#routing");
    await link.click();
    await expect(page).toHaveURL(/\/inbox#routing$/);
    await expect(page.getByTestId("routing").locator("> li").filter({ hasText: "e2e route seed two" })).toHaveCount(1);
  });
});
