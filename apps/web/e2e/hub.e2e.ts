// H2: the hub capture box. H3: the route picker on each row. Previews (and the local run) have the synthetic seed,
// which already holds some entries. Routing is off in these runs (no models secret), so a new entry shows
// "Waiting for router" and has no "Route again" button.
import { expect, test, type Page } from "@playwright/test";

test("hub redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/hub");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Hub" })).toHaveCount(0);
});

test.describe("as the preview owner", () => {
  // Both capture tests check that their entry is the newest row, so they must not insert at the same time.
  test.describe.configure({ mode: "serial" });
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
    const entries = page.getByTestId("entries").locator("> li");

    await page.getByLabel("Capture", { exact: true }).fill(`e2e capture ${stamp}`);
    await captureSave(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
    // The redirect leaves the box empty, and the new entry is the first row, pending.
    await expect(page.getByLabel("Capture", { exact: true })).toHaveValue("");
    const first = entries.first();
    await expect(first).toContainText(`e2e capture ${stamp}`);
    await expect(first.locator('[data-field="status"]')).toHaveText("Waiting for router");

    // Whitespace passes the browser's required check, so the server refuses it and nothing is stored.
    const before = await entries.count();
    await page.getByLabel("Capture", { exact: true }).fill("   \n  ");
    await captureSave(page).click();
    // Scoped: Next's own route announcer is also role=alert.
    await expect(page.getByRole("alert").filter({ hasText: "Nothing to save" })).toHaveCount(1);
    await expect(entries).toHaveCount(before);
    // The list is capped at ten rows, so the count alone cannot show "no row": the newest row is still ours.
    await expect(entries.first()).toContainText(`e2e capture ${stamp}`);
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
    await expect(page.getByTestId("entries").locator("> li").first()).toContainText(`e2e keyboard ${stamp}`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await captureSave(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("a pending entry is routed by hand: the row shows the new label, and no Route again while routing is off", async ({ page }) => {
    await signIn(page, "/hub");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const text = `e2e reassign ${stamp}`;
    await page.getByLabel("Capture", { exact: true }).fill(text);
    await captureSave(page).click();
    await expect(page.getByRole("status")).toHaveText("Saved");

    const row = page.getByTestId("entries").locator("> li").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-field="status"]')).toHaveText("Waiting for router");
    await expect(row.getByRole("button", { name: "Route again" })).toHaveCount(0);

    await row.getByRole("combobox").selectOption({ label: "Idea" });
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Idea.");
    await expect(page.getByTestId("entries").locator("> li").filter({ hasText: text }).locator('[data-field="status"]')).toHaveText(
      "Idea",
    );
  });

  test("a row that needs the owner links to the routing inbox (local seed)", async ({ page }) => {
    // The routing seed (e2e/support/local-db.ts) exists only in the local run.
    test.skip(!!process.env.BASE_URL, "the routing seed is local only");
    await signIn(page, "/hub");
    const row = page.getByTestId("entries").locator("> li").filter({ hasText: "e2e route seed two" });
    await expect(row).toHaveCount(1);
    const link = row.getByRole("link", { name: "Needs you" });
    await expect(link).toHaveAttribute("href", "/inbox#routing");
    await link.click();
    await expect(page).toHaveURL(/\/inbox#routing$/);
    await expect(page.getByTestId("routing").locator("> li").filter({ hasText: "e2e route seed two" })).toHaveCount(1);
  });
});
