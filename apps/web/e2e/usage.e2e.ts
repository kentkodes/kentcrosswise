// P2-15: usage panel. Previews (and the local run) have the synthetic seed: provider `seed` with
// made-up prices, one unpriced model and two Actions runs (11.75 minutes) in the last 30 days.
import { expect, test } from "@playwright/test";

test("the usage panel redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/console/usage");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Usage" })).toHaveCount(0);
});

test.describe("as the preview owner", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  test("shows seeded usage by agent, model and day, and Actions minutes", async ({ page }) => {
    await page.goto("/console/usage");
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto("/console/usage");

    await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    await expect(page.getByTestId("actions-minutes")).toContainText("Actions minutes ($0, public standard runners)");
    await expect(page.getByTestId("actions-minutes")).toContainText(/\d+\.\d\d min over \d+ runs/);
    await expect(page.getByTestId("by-agent").locator('tr[data-key="developer"]')).toBeVisible();
    await expect(page.getByTestId("by-model").locator('tr[data-key="seed/seed-large"] [data-field="cost"]')).toHaveText(/^\$\d/);
    await expect(page.getByTestId("by-model").locator('tr[data-key="seed/seed-unpriced"] [data-field="cost"]')).toHaveText(
      "no price",
    );
    await expect(page.getByTestId("by-day").locator("tbody tr").first()).toBeVisible();

    // A bad range falls back to the default and says so.
    await page.goto("/console/usage?from=2026-02-30&to=2026-03-01");
    await expect(page.getByRole("status")).toContainText("showing the last 30 days");

    await page.getByRole("link", { name: "Boss console" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Boss console" })).toBeVisible();
  });
});
