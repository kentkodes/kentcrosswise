// Hub integration: routed captures show up on their pages, CRM notes are linked to contacts, ambiguous notes reach
// the inbox, diary captures are listed as not scored, and the owner nav leads everywhere. Routing by the model is
// off in these runs, so captures are routed with the route picker. The database is shared with other e2e files:
// every item carries a unique marker and every assertion is scoped to it.
import { expect, test, type Locator, type Page } from "@playwright/test";

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

  const stampOf = () => `${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  async function capture(page: Page, text: string): Promise<void> {
    await page.goto("/hub");
    await page.getByLabel("Capture", { exact: true }).fill(text);
    await page.getByTestId("capture").getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("status")).toHaveText("Saved");
  }

  /** Routes the unresolved entry holding `text` to a kind with the row's picker (it must still be unresolved). */
  async function routeTo(page: Page, text: string, label: string): Promise<void> {
    const row = page.getByTestId("unresolved").locator("li").filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await row.getByText("Change route", { exact: true }).click();
    await row.getByRole("combobox").selectOption({ label });
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(`Routed to ${label}.`);
  }

  async function addContact(page: Page, name: string): Promise<void> {
    await page.goto("/contacts/new");
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Add contact" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Contact added." })).toHaveCount(1);
  }

  test("a Todo capture appears on /todos; reassigned to Idea it moves to /ideas", async ({ page }) => {
    await signIn(page, "/hub");
    const text = `e2e integ todo ${stampOf()}`;
    await capture(page, text);
    await routeTo(page, text, "Todo");
    await page.goto("/todos");
    await expect(page.getByTestId("todos").locator("li").filter({ hasText: text })).toHaveCount(1);

    // The routed entry is in the hub's recent list with its own picker; move it to Idea.
    await page.goto("/hub");
    const recent = page.getByTestId("recent").locator("li").filter({ hasText: text });
    await expect(recent).toHaveCount(1);
    await recent.getByText("Change route", { exact: true }).click();
    await recent.getByRole("combobox").selectOption({ label: "Idea" });
    await recent.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Routed to Idea.");

    await page.goto("/ideas");
    await expect(page.getByTestId("ideas").locator("li").filter({ hasText: text })).toHaveCount(1);
    await page.goto("/todos");
    await expect(page.getByTestId("todos").locator("li").filter({ hasText: text })).toHaveCount(0);
  });

  test("a CRM note naming one contact is linked to it", async ({ page }) => {
    await signIn(page, "/hub");
    const stamp = stampOf();
    const name = `Linky${stamp} Example`;
    await addContact(page, name);
    const text = `e2e integ met ${name} for tea`;
    await capture(page, text);
    await routeTo(page, text, "CRM note");
    await page.goto("/contacts");
    const note = page.getByTestId("notes").locator("li").filter({ hasText: text });
    await expect(note).toHaveCount(1);
    await expect(note.locator('[data-field="link"]')).toHaveText(`Linked to ${name}`);
  });

  test("a note naming two contacts waits in the inbox, and choosing there links it", async ({ page }) => {
    await signIn(page, "/hub");
    const stamp = stampOf();
    const one = `Twin${stamp} Alpha`;
    const two = `Twin${stamp} Beta`;
    await addContact(page, one);
    await addContact(page, two);
    const text = `e2e integ both ${one} and ${two} came`;
    await capture(page, text);
    await routeTo(page, text, "CRM note");

    await page.goto("/contacts");
    const note = page.getByTestId("notes").locator("li").filter({ hasText: text });
    await expect(note.locator('[data-field="link"]')).toHaveText("Choose a contact");

    await page.goto("/inbox");
    const waiting = page.getByTestId("contact-matches").locator("li").filter({ hasText: text });
    await expect(waiting).toHaveCount(1);
    await waiting.getByLabel("Contact").selectOption({ label: two });
    await waiting.getByRole("button", { name: "Save" }).click();
    await expect(page).toHaveURL(/\/inbox/);
    await expect(page.getByTestId("contact-matches").locator("li").filter({ hasText: text })).toHaveCount(0);

    await page.goto("/contacts");
    await expect(
      page.getByTestId("notes").locator("li").filter({ hasText: text }).locator('[data-field="link"]'),
    ).toHaveText(`Linked to ${two}`);
  });

  test("a Diary capture appears on /diary as not scored", async ({ page }) => {
    await signIn(page, "/hub");
    const text = `e2e integ diary ${stampOf()}`;
    await capture(page, text);
    await routeTo(page, text, "Diary");
    await page.goto("/diary");
    const entry = page.getByTestId("diary-entries").locator("li").filter({ hasText: text });
    await expect(entry).toHaveCount(1);
    await expect(entry.locator('[data-field="mood"]')).toHaveText("Not scored");
  });

  const PRIMARY = [
    ["Hub", "/hub"],
    ["Inbox", "/inbox"],
    ["Todos", "/todos"],
    ["Diary", "/diary"],
    ["Ideas", "/ideas"],
    ["Contacts", "/contacts"],
  ] as const;
  const MORE = [
    ["Mood", "/mood"],
    ["Social", "/social"],
    ["Projects", "/projects"],
    ["Essays", "/essays"],
    ["Boss console", "/console"],
    ["Usage", "/console/usage"],
    ["Connections", "/connections"],
    ["Notifications", "/notifications"],
  ] as const;

  /** The More links live in a closed <details>; open it only when it is shut. */
  async function openMore(nav: Locator): Promise<void> {
    const open = await nav.locator("details").evaluate((el) => (el as HTMLDetailsElement).open);
    if (!open) await nav.locator("summary").click();
  }

  for (const vp of [
    { label: "1280px", width: 1280, height: 900 },
    { label: "375px", width: 375, height: 800 },
  ]) {
    test(`every nav link leads to its page with the current item marked at ${vp.label}`, async ({ page }) => {
      test.setTimeout(150_000); // each page compiles on first visit in `next dev`
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signIn(page, "/hub");
      const nav = page.getByRole("navigation", { name: "Owner" });
      await expect(nav.getByRole("link")).toHaveText(PRIMARY.map(([label]) => label));
      expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await openMore(nav);
      await expect(nav.getByRole("link")).toHaveText([...PRIMARY, ...MORE].map(([label]) => label));
      for (const [label, path] of [...PRIMARY, ...MORE]) {
        await page.goto("/hub");
        if (MORE.some(([moreLabel]) => moreLabel === label)) await openMore(nav);
        await nav.getByRole("link", { name: label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
        await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
        await expect(nav.locator('a[aria-current="page"]')).toHaveText(label);
        await openMore(nav);
        await expect(nav.getByRole("link", { name: label, exact: true })).toBeInViewport();
        expect(await fits(page)).toBe(true);
        expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
    });
  }
});
