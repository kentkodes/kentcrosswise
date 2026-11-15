// H7: /todos, /ideas and /projects. Previews run one shared database, so other tests' rows exist too: every item
// this file creates carries a unique marker, every assertion is scoped to rows that hold the marker, and no test
// checks exact list lengths, empty states or positions in a shared list (the one order check compares two of
// this file's own projects).
import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";

// Against the local dev server, `next dev` compiles each route and action on its first hit, so the first round
// trips can be slow: longer timeouts there only. A deployed preview keeps the Playwright defaults.
const local = !process.env.BASE_URL;
const expect = local ? baseExpect.configure({ timeout: 20_000 }) : baseExpect;
const token = process.env.KCW_E2E_LOGIN;

function marker(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test("the lists redirect to sign-in when logged out", async ({ page }) => {
  if (local) test.setTimeout(120_000);
  for (const path of ["/todos", "/ideas", "/projects"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/api\/auth\/signin/);
  }
  await expect(page.getByRole("heading", { name: "Todos" })).toHaveCount(0);
});

test.describe("as the preview owner", () => {
  // Each test here creates its own rows; serial keeps this file's own rows from interleaving.
  test.describe.configure({ mode: "serial", ...(local ? { timeout: 180_000 } : {}) });
  test.skip(!token, "KCW_E2E_LOGIN is not set (prod targets have no preview login)");

  async function signIn(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await page.getByLabel("Preview login token").fill(token!);
    await page.getByRole("button", { name: "Sign in with Preview login" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/api/auth/signin"));
    await page.goto(path);
  }

  // The row that holds this marker, in the todo list.
  const todoRow = (page: Page, text: string): Locator => page.getByTestId("todos").locator("> li").filter({ hasText: text });
  const ideaRow = (page: Page, text: string): Locator => page.getByTestId("ideas").locator("> li").filter({ hasText: text });
  const projectRow = (page: Page, slug: string): Locator => page.locator(`[data-project="${slug}"]`);

  test("adds a todo, marks it done, undoes it and deletes it", async ({ page }) => {
    await signIn(page, "/todos");
    await expect(page.getByRole("heading", { level: 1, name: "Todos" })).toBeVisible();
    const text = `e2e todo ${marker()}`;

    await page.getByLabel("Todo", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Todo added." })).toHaveCount(1);
    const row = todoRow(page, text);
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-field="status"]')).toHaveText("Open");

    await row.getByRole("button", { name: "Mark done" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Marked done." })).toHaveCount(1);
    await expect(todoRow(page, text).locator('[data-field="status"]')).toHaveText("Done");

    await todoRow(page, text).getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Marked open again." })).toHaveCount(1);
    await expect(todoRow(page, text).locator('[data-field="status"]')).toHaveText("Open");

    await todoRow(page, text).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Todo deleted." })).toHaveCount(1);
    await expect(todoRow(page, text)).toHaveCount(0);
  });

  test("adds an idea and changes its status", async ({ page }) => {
    await signIn(page, "/ideas");
    await expect(page.getByRole("heading", { level: 1, name: "Ideas" })).toBeVisible();
    const text = `e2e idea ${marker()}`;

    await page.getByLabel("Idea", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Idea added." })).toHaveCount(1);
    await expect(ideaRow(page, text).locator('[data-field="status"]')).toHaveText("Open");

    await ideaRow(page, text).getByRole("button", { name: `Done: ${text}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Status changed." })).toHaveCount(1);
    await expect(ideaRow(page, text).locator('[data-field="status"]')).toHaveText("Done");

    await ideaRow(page, text).getByRole("button", { name: `Dropped: ${text}` }).click();
    await expect(ideaRow(page, text).locator('[data-field="status"]')).toHaveText("Dropped");

    await ideaRow(page, text).getByRole("button", { name: "Delete" }).click();
    await expect(ideaRow(page, text)).toHaveCount(0);
  });

  test("adds, reorders and deletes a project; Essays cannot be renamed or deleted", async ({ page }) => {
    await signIn(page, "/projects");
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    const stamp = marker();
    const titleA = `e2e garden ${stamp}`;
    const titleB = `e2e studio ${stamp}`;
    const slugA = `e2e-garden-${stamp}`;
    const slugB = `e2e-studio-${stamp}`;

    // Add A, then B: each add selects the new tab.
    await page.getByLabel("New project title", { exact: true }).fill(titleA);
    await page.getByRole("button", { name: "Add project" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Project added." })).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`tab=${slugA}`));
    await expect(page.getByRole("region", { name: titleA })).toContainText("No page for this project yet.");

    await page.getByLabel("New project title", { exact: true }).fill(titleB);
    await page.getByRole("button", { name: "Add project" }).click();
    await expect(page).toHaveURL(new RegExp(`tab=${slugB}`));

    // Another test may add projects between A and B in the shared database, so B moves up until it is above A.
    // Only the relative order of these two rows is asserted.
    const orderOf = () => page.getByTestId("projects").locator("> li").evaluateAll((items) => items.map((i) => i.getAttribute("data-project")));
    for (let step = 0; step < 50; step++) {
      const order = await orderOf();
      if (order.indexOf(slugB) < order.indexOf(slugA)) break;
      await projectRow(page, slugB).getByRole("button", { name: "Move up" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Project order saved." })).toHaveCount(1);
    }
    const finalOrder = await orderOf();
    expect(finalOrder.indexOf(slugB)).toBeLessThan(finalOrder.indexOf(slugA));

    // The Essays row is built in: no rename field and no delete button.
    await expect(projectRow(page, "essays").getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expect(projectRow(page, "essays").getByLabel("Rename", { exact: true })).toHaveCount(0);

    // Rename A, then delete both.
    await projectRow(page, slugA).getByLabel("Rename", { exact: true }).fill(`${titleA} renamed`);
    await projectRow(page, slugA).getByRole("button", { name: `Rename project ${titleA}` }).click();
    await expect(page.getByRole("status").filter({ hasText: "Project renamed." })).toHaveCount(1);
    await expect(projectRow(page, slugA)).toContainText(`${titleA} renamed`);

    await page.goto(`/projects?tab=${slugB}`);
    await projectRow(page, slugB).getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Project deleted." })).toHaveCount(1);
    await expect(projectRow(page, slugB)).toHaveCount(0);
    await projectRow(page, slugA).getByRole("button", { name: "Delete" }).click();
    await expect(projectRow(page, slugA)).toHaveCount(0);
  });

  test("the Essays tab shows the library summary and links to it", async ({ page }) => {
    await signIn(page, "/projects?tab=essays");
    await expect(page.getByTestId("tab")).toContainText("in the library");
    await expect(page.getByRole("link", { name: "Open the library" })).toHaveAttribute("href", "/essays");
  });

  test("the lists fit a 375px phone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await signIn(page, "/todos");
    for (const path of ["/todos", "/ideas", "/projects"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    // The add field and its button work on a phone: a marked todo appears and is deleted again.
    await page.goto("/todos");
    const text = `e2e phone todo ${marker()}`;
    await page.getByLabel("Todo", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(todoRow(page, text)).toHaveCount(1);
    await todoRow(page, text).getByRole("button", { name: "Delete" }).click();
    await expect(todoRow(page, text)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
