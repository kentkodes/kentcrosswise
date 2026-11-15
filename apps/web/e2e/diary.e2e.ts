// H6 diary and mood board. Model routing is off in these runs, so nothing is scored. The database is shared with
// other tests: every entry carries a unique marker and every assertion is scoped to rows with that marker (no
// list lengths, empty states, chart point counts or first/last positions).
import { expect, test, type Page } from "@playwright/test";

test("diary and mood redirect to sign-in when logged out", async ({ page }) => {
  for (const path of ["/diary", "/mood"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/api\/auth\/signin/);
  }
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

  const marker = () => `e2e-diary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  for (const [label, size] of [
    ["desktop", { width: 1280, height: 900 }],
    ["375px", { width: 375, height: 800 }],
  ] as const) {
    test(`writes, edits and deletes an entry (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await signIn(page, "/diary");
      const m = marker();
      const row = page.locator("li[data-diary-id]").filter({ hasText: m });

      await page.getByLabel("New entry").fill(`First line ${m}\n\nSecond paragraph.`);
      await page.getByTestId("diary-editor").getByRole("button", { name: "Save" }).click();
      await expect(page.getByRole("status")).toContainText("Saved");
      await expect(row).toHaveCount(1);
      await expect(row.locator('[data-field="mood"]')).toHaveText("Not scored");

      await row.getByRole("link").click();
      await expect(page.getByRole("heading", { level: 1, name: "Diary entry" })).toBeVisible();
      await expect(page.getByTestId("diary-text")).toContainText(m);
      await expect(page.getByTestId("diary-mood")).toContainText("Not scored");
      await expect(page.getByTestId("diary-mood")).toContainText("Mood scoring is not set up here.");
      await expect(page.getByRole("button", { name: "Score again" })).toHaveCount(0);
      expect(await noSideScroll(page)).toBe(true);

      await page.getByLabel("Text", { exact: true }).fill(`Edited ${m}`);
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("status")).toContainText("Saved");
      await expect(page.getByTestId("diary-text")).toHaveText(`Edited ${m}`);

      // Delete asks first; Cancel keeps the entry.
      await page.getByRole("link", { name: "Delete", exact: true }).click();
      await expect(page.getByText("Delete this entry and its mood scores?")).toBeVisible();
      await page.getByRole("link", { name: "Cancel" }).click();
      await expect(page.getByTestId("diary-text")).toContainText(m);
      await page.getByRole("link", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Yes, delete" }).click();
      await expect(page.getByRole("status")).toHaveText("Entry deleted.");
      await expect(page).toHaveURL(/\/diary\?n=deleted/);
      await expect(page.locator("li[data-diary-id]").filter({ hasText: m })).toHaveCount(0);
    });

    test(`opens the mood board with scoring off (${label})`, async ({ page }) => {
      await page.setViewportSize(size);
      await signIn(page, "/mood");
      await expect(page.getByRole("heading", { level: 1, name: "Mood" })).toBeVisible();
      await expect(page.getByTestId("panel-sentiment")).toBeVisible();
      await expect(page.getByTestId("panel-metrics")).toBeVisible();
      await expect(page.getByTestId("summary-sentiment")).not.toBeEmpty();
      await expect(page.getByTestId("summary-metrics")).not.toBeEmpty();

      const names = ["Energy", "Stress", "Happiness", "Satisfaction", "Sadness", "Anger", "Anxiety", "Gratitude"];
      for (const n of names) await expect(page.getByRole("checkbox", { name: n })).toBeChecked();
      await page.getByRole("checkbox", { name: "Stress" }).uncheck();
      await expect(page.getByRole("checkbox", { name: "Stress" })).not.toBeChecked();
      await expect(page.locator('[data-metric="stress"]')).toHaveCount(0);

      await expect(page.getByTestId("range-note")).toContainText("last 90 days");
      await page.getByRole("link", { name: "Show all" }).click();
      await expect(page).toHaveURL(/range=all/);
      await expect(page.getByTestId("range-note")).toContainText("All scored entries");
      await page.getByText("Data table").click();
      await expect(page.getByRole("columnheader", { name: "Sentiment" })).toBeVisible();
      expect(await noSideScroll(page)).toBe(true);
    });
  }
});
