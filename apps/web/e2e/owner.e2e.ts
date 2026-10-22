import { expect, test } from "@playwright/test";

test("owner routes redirect to sign-in when logged out", async ({ page }) => {
  const response = await page.goto("/hub");
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Hub" })).toHaveCount(0);
});

test.describe("preview login", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  test("a wrong token is rejected", async ({ page }) => {
    await page.goto("/api/auth/signin");
    await page.getByLabel("Preview login token").fill("wrong-token-0000000000");
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await expect(page).toHaveURL(/error=CredentialsSignin/);
    await page.goto("/hub");
    await expect(page).toHaveURL(/\/api\/auth\/signin/);
  });

  test("the e2e token signs in as the preview owner", async ({ page }) => {
    await page.goto("/hub");
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto("/hub");
    await expect(page.getByRole("heading", { level: 1, name: "Hub" })).toBeVisible();
  });
});
