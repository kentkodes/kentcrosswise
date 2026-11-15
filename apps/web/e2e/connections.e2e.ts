// W2-3: the Google connection page. Previews have no Google provider and no token secret.
import { expect, test } from "@playwright/test";

test("connections redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/connections");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Connections" })).toHaveCount(0);
});

test.describe("as the preview owner", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  test("shows Not connected and that Google is not configured here", async ({ page }) => {
    await page.goto("/connections");
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto("/connections");
    await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
    const google = page.getByTestId("google");
    await expect(google.getByText("Not connected")).toBeVisible();
    await expect(google.getByText(/Google is not configured here/)).toBeVisible();
    await expect(google.getByRole("button")).toHaveCount(0);
  });
});
