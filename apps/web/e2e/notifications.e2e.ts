// W2-6: web push page and manifest. Previews have no VAPID keys, so the page says push is not set up.
import { expect, test } from "@playwright/test";

test("notifications redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Notifications" })).toHaveCount(0);
});

test("the manifest is standalone", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  const manifest = await res.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/hub");
});

test.describe("as the preview owner", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  test("says push is not set up and does not scroll sideways at 375 px", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/notifications");
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto("/notifications");
    await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();
    const region = page.getByTestId("push");
    await expect(region.getByText(/Push is not set up here/)).toBeVisible();
    await expect(region.getByText(/Home Screen/)).toBeVisible();
    await expect(region.getByRole("button")).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
