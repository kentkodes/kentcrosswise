// P2-14: boss console and inbox. Previews (and the local run) have the synthetic seed with two
// pending approvals, and no orchestrator queue, so tasks are saved but not sent.
import { expect, test, type Page } from "@playwright/test";

test("console and inbox redirect to sign-in when logged out", async ({ page }) => {
  for (const path of ["/console", "/inbox"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/api\/auth\/signin/);
  }
  await expect(page.getByRole("heading", { name: "Boss console" })).toHaveCount(0);
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

  test("creates a private task by default, and a public one when unchecked", async ({ page }) => {
    await signIn(page, "/console");
    await expect(page.getByRole("heading", { level: 1, name: "Boss console" })).toBeVisible();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await expect(page.getByRole("checkbox", { name: /Private/ })).toBeChecked();
    await page.getByLabel("Task", { exact: true }).fill(`e2e private task ${stamp}`);
    await page.getByRole("button", { name: "Create task" }).click();
    await expect(page.getByRole("status")).toContainText("Task created");
    const priv = page.getByTestId("tasks").locator("> li").filter({ hasText: `e2e private task ${stamp}` });
    await expect(priv).toHaveCount(1);
    await expect(priv.locator('[data-field="status"]')).toHaveText("queued");
    await expect(priv.locator('[data-field="visibility"]')).toHaveText("private");

    await page.getByLabel("Task", { exact: true }).fill(`e2e public task ${stamp}`);
    await page.getByRole("checkbox", { name: /Private/ }).uncheck();
    await page.getByRole("button", { name: "Create task" }).click();
    const pub = page.getByTestId("tasks").locator("> li").filter({ hasText: `e2e public task ${stamp}` });
    await expect(pub.locator('[data-field="visibility"]')).toHaveText("public");
  });

  test("lists seeded tasks with their events", async ({ page }) => {
    await signIn(page, "/console");
    const seeded = page.getByTestId("tasks").locator("> li").filter({ hasText: "[seed] Add a /healthz page" });
    await expect(seeded).toHaveCount(1);
    await expect(seeded).toContainText("waiting on owner");
    await seeded.getByText(/\d+ events/).click();
    await expect(seeded.getByText("orchestrator waiting on owner")).toBeVisible();
  });

  test("pauses and resumes agents and pipelines", async ({ page }) => {
    await signIn(page, "/console");
    for (const name of ["agents", "pipelines"]) {
      // Start from "running" whatever an earlier (retried) run left behind.
      const resume = page.getByRole("button", { name: `Resume ${name}` });
      if (await resume.count()) await resume.click();
      await page.getByRole("button", { name: `Pause ${name}` }).click();
      await expect(page.getByRole("status")).toHaveText("Switch updated.");
      await expect(page.getByRole("button", { name: `Resume ${name}` })).toBeVisible();
      await page.getByRole("button", { name: `Resume ${name}` }).click();
      await expect(page.getByRole("button", { name: `Pause ${name}` })).toBeVisible();
    }
  });

  test("approves and rejects the seeded approvals", async ({ page }) => {
    await signIn(page, "/inbox");
    await expect(page.getByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const cases = [
      { reason: "seed: infra/prod changed", button: "Approve", status: "approved" },
      { reason: "seed: new dependency", button: "Reject", status: "rejected" },
    ];
    for (const c of cases) {
      const pending = page.getByTestId("pending").locator("> li").filter({ hasText: c.reason });
      // A retried run finds it already decided.
      if (await pending.count()) {
        await pending.getByLabel("Note").fill(`e2e ${c.status}`);
        await pending.getByRole("button", { name: c.button }).click();
        await expect(page.getByRole("status")).toContainText("Decision recorded");
      }
      const decided = page.getByTestId("decided").locator("> li").filter({ hasText: c.reason });
      await expect(decided.locator('[data-field="status"]')).toHaveText(c.status);
      await expect(page.getByTestId("pending").locator("> li").filter({ hasText: c.reason })).toHaveCount(0);
    }
  });
});
