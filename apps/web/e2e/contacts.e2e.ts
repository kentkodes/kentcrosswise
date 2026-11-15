// H4: contacts pages. Every contact is created through the UI with a unique marker in its name, and every assertion
// is scoped to rows holding that marker (the preview database is shared with other tests and seeded).
import { expect, test, type Page } from "@playwright/test";

test("contacts redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/contacts");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Contacts" })).toHaveCount(0);
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

  const widths = [
    { label: "desktop", width: 1280, height: 900 },
    { label: "375px", width: 375, height: 800 },
  ];

  for (const vp of widths) {
    test(`creates, edits, filters and deletes a contact at ${vp.label}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
      const name = `Zed${stamp} Example`;
      const renamed = `Zed${stamp} Renamed`;
      const alias = `nick${stamp}`;

      await signIn(page, "/contacts");
      await expect(page.getByRole("heading", { level: 1, name: "Contacts" })).toBeVisible();
      await page.getByRole("link", { name: "Add contact" }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Add contact" })).toBeVisible();

      // Name is required: the server also refuses a whitespace-only name.
      await page.getByLabel("Name", { exact: true }).fill("   ");
      await page.getByRole("button", { name: "Add contact" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "needs a name" })).toHaveCount(1);

      await page.getByLabel("Name", { exact: true }).fill(name);
      await page.getByLabel("Aliases").fill(` ${alias}, ${alias.toUpperCase()} ,, other${stamp}`);
      await page.getByLabel("How known").fill("Met at a synthetic meetup");
      await page.getByLabel("Birthday").fill("1990-02-28");
      await page.getByLabel("Notes", { exact: true }).fill("Likes tea");
      await page.getByLabel("Tags").fill(`club${stamp}, Club${stamp}`);
      await page.getByRole("button", { name: "Add contact" }).click();

      await expect(page.getByRole("status").filter({ hasText: "Contact added." })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
      // De-duplicated, case-insensitively.
      await expect(page.getByLabel("Aliases")).toHaveValue(`${alias}, other${stamp}`);
      await expect(page.getByLabel("Tags")).toHaveValue(`club${stamp}`);
      await expect(page.getByLabel("Birthday")).toHaveValue("1990-02-28");

      // Edit.
      await page.getByLabel("Name", { exact: true }).fill(renamed);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Contact saved." })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();

      // Filter by name, alias and tag.
      for (const term of [`Zed${stamp}`, alias, `club${stamp}`]) {
        await page.goto(`/contacts?q=${encodeURIComponent(term)}`);
        await expect(page.getByTestId("contacts").getByRole("link", { name: renamed })).toHaveCount(1);
      }
      await page.goto(`/contacts?q=${encodeURIComponent(`nomatch${stamp}`)}`);
      await expect(page.getByTestId("contacts").getByRole("link", { name: renamed })).toHaveCount(0);

      // The filter form works from the page.
      await page.goto("/contacts");
      await page.getByLabel("Filter", { exact: true }).fill(`Zed${stamp}`);
      await page.getByRole("button", { name: "Filter" }).click();
      await expect(page).toHaveURL(new RegExp(`q=Zed${stamp}`));
      const row = page.getByTestId("contacts").locator("li").filter({ hasText: renamed });
      await expect(row).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      // Delete needs the confirmation step.
      await row.getByRole("link", { name: renamed }).click();
      await expect(page.getByRole("heading", { level: 1, name: renamed })).toBeVisible();
      await expect(page.getByRole("button", { name: "Confirm delete" })).toBeHidden();
      await page.getByText("Delete this contact").click();
      await page.getByRole("button", { name: "Confirm delete" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Contact deleted." })).toHaveCount(1);
      await page.goto(`/contacts?q=${encodeURIComponent(`Zed${stamp}`)}`);
      await expect(page.getByTestId("contacts").getByRole("link", { name: renamed })).toHaveCount(0);
    });
  }
});
