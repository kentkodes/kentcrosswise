// H5: the capture form sends the browser's time zone and the entry stores it; /inbox shows the Calendar region with
// no suggestions (preview has no model and no Google client, so nothing can create one). The stored-zone check
// reads the local PGlite server, so it runs only without BASE_URL.
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

test.describe("calendar as the preview owner", () => {
  const token = process.env.KCW_E2E_LOGIN;
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");
  test.use({ timezoneId: "America/New_York" });

  async function signIn(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto(path);
  }

  test("the capture form sends the browser zone and the entry stores it", async ({ page }) => {
    await signIn(page, "/hub");
    await expect(page.locator('input[name="time_zone"]')).toHaveValue("America/New_York");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const text = `e2e calendar zone ${stamp}`;
    await page.getByLabel("Capture", { exact: true }).fill(text);
    await page.getByTestId("capture").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");

    test.skip(!!process.env.BASE_URL, "reading the stored zone needs the local database");
    const client = new pg.Client({ connectionString: `postgres://postgres@127.0.0.1:${Number(process.env.PW_DB_PORT ?? 3918)}/postgres` });
    await client.connect();
    try {
      const { rows } = await client.query<{ time_zone: string | null }>("SELECT time_zone FROM entries WHERE raw_text = $1", [text]);
      expect(rows).toEqual([{ time_zone: "America/New_York" }]);
    } finally {
      await client.end();
    }
  });

  test("/inbox renders the Calendar region with no suggestions", async ({ page }) => {
    await signIn(page, "/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const region = page.getByTestId("calendar");
    await expect(region.getByRole("heading", { name: "Calendar" })).toBeVisible();
    await expect(region).toContainText("No calendar suggestions.");
    await expect(region.locator("li")).toHaveCount(0);
  });
});
