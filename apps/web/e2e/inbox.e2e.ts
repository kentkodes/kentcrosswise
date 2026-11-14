// H3: the Routing region on /inbox. It needs the local routing seed (e2e/support/local-db.ts: two open routing
// items), so it runs only against the local server, not against a deployed preview.
import { expect, test, type Page } from "@playwright/test";

test.describe("routing as the preview owner", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");
  test.skip(!!process.env.BASE_URL, "the routing seed is local only (e2e/support/local-db.ts)");

  async function signIn(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto(path);
  }

  test("a kind closes the routing item, and /hub shows the new label", async ({ page }) => {
    await signIn(page, "/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const routing = page.getByTestId("routing").locator("> li");
    const item = routing.filter({ hasText: "e2e route seed one" });
    await expect(item).toHaveCount(1);
    // The guess and its confidence (two decimals) are shown; the guess is the primary button.
    await expect(item.locator('[data-field="guess"]')).toHaveText("CRM note");
    await expect(item).toContainText("0.42");
    await item.getByRole("button", { name: "Todo", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Todo.");
    await expect(routing.filter({ hasText: "e2e route seed one" })).toHaveCount(0);

    await page.goto("/hub");
    const row = page.getByTestId("entries").locator("> li").filter({ hasText: "e2e route seed one" });
    await expect(row.locator('[data-field="status"]')).toHaveText("Todo");
  });
});
