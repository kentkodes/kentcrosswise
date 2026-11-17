import { expect, test, type Page } from "@playwright/test";

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

test.describe("owner nav", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  async function signIn(page: Page): Promise<void> {
    await page.goto("/hub");
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto("/hub");
  }

  test("the More disclosure opens, navigates, and names the page it hides", async ({ page }) => {
    await signIn(page);
    const nav = page.getByRole("navigation", { name: "Owner" });
    const summary = nav.locator("summary");
    await expect(summary).toHaveText("More");

    await summary.click();
    await nav.getByRole("link", { name: "Usage", exact: true }).click();
    await expect(page).toHaveURL(/\/console\/usage$/);
    await expect(nav.locator('a[aria-current="page"]')).toHaveText("Usage");
    await expect(summary).toHaveText("More: Usage");
  });

  test("the nav stays on one line at 375px and 1280px", async ({ page }) => {
    await signIn(page);
    const nav = page.getByRole("navigation", { name: "Owner" });
    for (const width of [375, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/hub");
      const fits = await nav.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(fits, `nav scrollWidth exceeds clientWidth at ${width}px`).toBe(true);
      if (!(await nav.locator("details").evaluate((el) => (el as HTMLDetailsElement).open))) {
        await nav.locator("summary").click();
      }
      const boxes = [nav.locator("summary"), ...(await nav.getByRole("link").all())];
      for (const box of boxes) {
        expect((await box.boundingBox())!.height, `tap target at ${width}px`).toBeGreaterThanOrEqual(44);
      }
    }
  });
});
