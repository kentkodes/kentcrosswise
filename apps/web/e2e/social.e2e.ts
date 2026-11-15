// H11: the social dashboard at /social. Owner only; the preview login is the same as the other owner e2e.
// Shared preview database: every account has a unique handle, rows are found by that handle, and totals are
// checked as the change from a reading taken just before the entry (never as an absolute site-wide value).
import { expect, test, type Locator, type Page } from "@playwright/test";

const token = process.env.KCW_E2E_LOGIN;

const isoDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function uniqueHandle(): string {
  return `e2e_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** The accounts-table row for this handle (rows are found by handle only). */
const rowFor = (page: Page, handle: string): Locator => page.getByTestId("account-table").locator("tr", { hasText: handle });

/** The number at the start of a followers cell ("1,250", "500 (12 Nov)", "300 rounded"), or null for "none". */
function cellNumber(text: string): number | null {
  const m = text.trim().match(/^[\d,]+/);
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

/**
 * The total shown equals the sum of the follower cells rendered on the same page. Other writers in the shared
 * database can change the rows between two reads, so the caller polls this until it holds on one render.
 */
async function totalMatchesRows(page: Page): Promise<boolean> {
  const totalText = (await page.getByTestId("totals").locator('[data-field="total-followers"]').innerText()).trim();
  const cells = await page.getByTestId("account-table").locator('[data-field="followers"]').allInnerTexts();
  const values = cells.map(cellNumber).filter((n): n is number => n !== null);
  if (totalText === "no numbers yet") return values.length === 0;
  return Number(totalText.replace(/,/g, "")) === values.reduce((sum, n) => sum + n, 0);
}

test("social redirects to sign-in when logged out", async ({ page }) => {
  await page.goto("/social");
  await expect(page).toHaveURL(/\/api\/auth\/signin/);
  await expect(page.getByRole("heading", { name: "Social" })).toHaveCount(0);
});

test.describe("as the preview owner", () => {
  // The two flows share the instagram source and the database: run them one after the other.
  test.describe.configure({ mode: "serial" });
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  async function signIn(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto(path);
  }

  /** Adds an account, enters two days of numbers, checks totals and change, filters, and deletes it. */
  async function runFlow(page: Page): Promise<void> {
    const handle = uniqueHandle();
    const day1 = isoDaysAgo(2);
    const day2 = isoDaysAgo(1);

    await signIn(page, "/social?source=instagram");
    await expect(page.getByRole("heading", { level: 1, name: "Social" })).toBeVisible();

    // Add the account (ingest is manual; the row says so once numbers exist).
    // A label that wraps a select is named with the selected option too ("Platform YouTube"), so match the start.
    await page.getByRole("region", { name: "Add account" }).getByLabel("Platform").selectOption("instagram");
    await page.getByLabel("Handle", { exact: true }).fill(`@${handle}`);
    await page.getByRole("region", { name: "Add account" }).getByRole("button", { name: "Add account" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Account added" })).toHaveCount(1);
    await expect(rowFor(page, handle)).toHaveCount(1);

    // Two days of numbers: the older one first, then the newer one, which becomes the latest.
    const snapshot = page.getByRole("region", { name: "Enter numbers for a day" });
    const pick = async () => snapshot.getByLabel("Account").selectOption({ label: `Instagram ${handle}` });
    await pick();
    await snapshot.getByLabel("Day (UTC)").fill(day1);
    await snapshot.getByLabel("Followers", { exact: true }).fill("100");
    await snapshot.getByLabel("Views", { exact: true }).fill("1000");
    await snapshot.getByRole("button", { name: "Save numbers" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Numbers saved" })).toHaveCount(1);
    // The first day alone: our row shows its numbers, with no change yet; the total matches the rows on this page.
    await expect(rowFor(page, handle).locator('[data-field="followers"]')).toContainText("100");
    await expect(rowFor(page, handle).locator('[data-field="followers-change"]')).toHaveText("—");
    await expect.poll(() => totalMatchesRows(page)).toBe(true);

    await pick();
    await snapshot.getByLabel("Day (UTC)").fill(day2);
    await snapshot.getByLabel("Followers", { exact: true }).fill("130");
    await snapshot.getByLabel("Views", { exact: true }).fill("1500");
    await snapshot.getByRole("button", { name: "Save numbers" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Numbers saved" })).toHaveCount(1);

    const row = rowFor(page, handle);
    await expect(row.locator('[data-field="followers"]')).toContainText("130");
    await expect(row.locator('[data-field="followers-change"]')).toHaveText("+30");
    await expect(row.locator('[data-field="views-change"]')).toHaveText("+500");
    await expect(row.locator('[data-field="day"]')).toHaveText(day2);
    await expect(row.locator('[data-field="ingest"]')).toHaveText("Manual");
    // The total is the sum of the rows shown here (our 130 included), whoever else is writing.
    await expect.poll(() => totalMatchesRows(page)).toBe(true);

    // Source filter: the account is not under YouTube, and is under Instagram.
    await page.getByRole("navigation", { name: "Source" }).getByRole("link", { name: "YouTube" }).click();
    await expect(page).toHaveURL(/source=youtube/);
    await expect(rowFor(page, handle)).toHaveCount(0);
    await page.getByRole("navigation", { name: "Source" }).getByRole("link", { name: "Instagram" }).click();
    await expect(rowFor(page, handle)).toHaveCount(1);

    // Delete with the confirmation step; the account and its numbers go.
    await rowFor(page, handle).getByRole("link", { name: "Delete" }).click();
    const confirm = page.getByTestId("confirm-delete");
    await expect(confirm).toContainText(handle);
    await confirm.getByRole("button", { name: "Delete account" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Account deleted" })).toHaveCount(1);
    await expect(rowFor(page, handle)).toHaveCount(0);
    await expect.poll(() => totalMatchesRows(page)).toBe(true);
  }

  test("adds an account, enters two days, sees totals and change, filters and deletes it (desktop)", async ({ page }) => {
    await runFlow(page);
  });

  test("the same flow at 375 px wide, with no sideways scrolling of the page", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await runFlow(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
