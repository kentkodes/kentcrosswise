// /office Board tab on the public office feed (/api/public/office). Every response is a fictional envelope from
// test/fixtures/office-contract.ts, served through the shared route mocks in e2e/support/office-mocks.ts.
import { expect, test, type Page } from "@playwright/test";
import { REFS, unavailableFixture } from "../test/fixtures/office-contract";
import { installPausedClock } from "./support/clock";
import { freshBootstrap, mockOfficeFeed } from "./support/office-mocks";

const CARD_TITLES = ["Orchestrator", "Developer", "QA", "Docs-keeper", "Scraper-builder"];

/** The Board tab's panel, which holds the cards and the activity list. */
const boardPanel = (page: Page) => page.locator("#office-panel-board");
/** The activity list region: "Activity" when live, "Activity · replay" when showing recorded events. */
const activityRegion = (page: Page) => page.getByRole("region", { name: /^Activity/ });

test("renders five role cards with their model tags", async ({ page }) => {
  await mockOfficeFeed(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  await expect(page.getByRole("heading", { level: 1, name: "Agent office" })).toBeVisible();
  const headings = boardPanel(page).getByRole("heading", { level: 3 });
  await expect(headings).toHaveCount(5);
  for (const [index, title] of CARD_TITLES.entries()) await expect(headings.nth(index)).toContainText(title);
  await expect(boardPanel(page).getByText("Opus 5.5", { exact: true })).toHaveCount(1);
  await expect(boardPanel(page).getByText("DeepSeek Flash", { exact: true })).toHaveCount(4);
});

/** Seat 2 runs the docs-keeper's running execution as a Developer, so the fixture has a working seat. */
function workingSeatTwo(makePublic: boolean) {
  const e = freshBootstrap();
  const run = e.snapshot.executions!.find(x => x.ref === REFS.privateTwoRun)!;
  run.role = "developer"; run.assignment = { station: "developer", seat: 2 };
  e.snapshot.tasks!.find(t => t.ref === REFS.privateTwo)!.role = "developer";
  const event = e.history.replay!.events.find(x => x.task_ref === REFS.privateTwo)!;
  event.role = "developer";
  if (makePublic) {
    const task = e.snapshot.tasks!.find(t => t.ref === REFS.privateTwo)!;
    task.visibility = "public"; task.description = "Seat two work";
    event.visibility = "public"; event.description = "Seat two work";
  }
  return e;
}

test("a working Developer seat shows its task text", async ({ page }) => {
  await mockOfficeFeed(page, () => workingSeatTwo(true));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const seat = boardPanel(page).locator("li").filter({ hasText: "Seat 2" });
  await expect(seat).toContainText("Working");
  await expect(seat).toContainText("Seat two work");
  await expect(boardPanel(page).locator("li").filter({ hasText: "Seat 1" })).toContainText("Idle");
});

test("a private working seat shows 'Private task'", async ({ page }) => {
  // The contract accepts only "Private task" as a private description, so a title cannot reach the board.
  // The title rule itself is covered by the unit test in office-board-state.test.ts.
  await mockOfficeFeed(page, () => workingSeatTwo(false));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const seat = boardPanel(page).locator("li").filter({ hasText: "Seat 2" });
  await expect(seat).toContainText("Working");
  await expect(seat).toContainText("Private task");
  await expect(activityRegion(page)).toContainText("Private task");
});

test("filter chips narrow the activity list by role", async ({ page }) => {
  await mockOfficeFeed(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const log = activityRegion(page);
  const chip = (name: string) => log.getByRole("button", { name, exact: true });
  await expect(log.locator("ol > li")).toHaveCount(3);
  await expect(chip("All")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("Developer")).toHaveAttribute("aria-pressed", "false");

  await chip("Developer").click();
  await expect(chip("Developer")).toHaveAttribute("aria-pressed", "true");
  await expect(chip("All")).toHaveAttribute("aria-pressed", "false");
  await expect(log.locator("ol > li")).toHaveCount(1);
  await expect(log.locator("ol > li").first()).toContainText("Coding reported");

  await chip("QA").click();
  await expect(log.locator("ol > li")).toHaveCount(1);
  await expect(log.locator("ol > li").first()).toContainText("Merged");

  await chip("Orchestrator").click();
  await expect(log.locator("ol > li")).toHaveCount(0);
  await expect(log).toContainText("No events for this filter in the current list.");
});

test("with only replay data the list is titled 'Activity · replay' and keeps original times", async ({ page }) => {
  await mockOfficeFeed(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const log = activityRegion(page);
  await expect(log.getByRole("heading", { name: "Activity · replay", exact: true })).toBeVisible();
  await expect(log).toContainText("Latest recorded events with their original times.");
  await expect(log.locator("time").first()).toHaveAttribute("datetime", "2026-10-25T18:20:00.000Z");
});

test("an unavailable feed with no data shows cards with 'Status unavailable' and invents no events", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: {} }));
  await page.route("**/api/public/office**", route => route.fulfill({ json: unavailableFixture() }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const panel = boardPanel(page);
  await expect(panel.getByRole("heading", { level: 3 })).toHaveCount(5);
  // Four role cards and four developer seats each show the unavailable text.
  await expect(panel.getByText("Status unavailable", { exact: true })).toHaveCount(8);
  await expect(page.getByText("Feed unavailable", { exact: true })).toBeVisible();
  const log = activityRegion(page);
  await expect(log.locator("li")).toHaveCount(0);
  await expect(log).toContainText("The office feed is unavailable. Retrying shortly.");
});

test("after data, a failed poll keeps the rows and says updates will retry", async ({ page }) => {
  await mockOfficeFeed(page, freshBootstrap);
  let fail = false;
  // Registered after mockOfficeFeed, so it runs first: it fails every poll once `fail` is set, and otherwise falls through.
  await page.route("**/api/public/office**", route => (fail ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fallback()));
  await installPausedClock(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const log = activityRegion(page);
  await expect(log.locator("ol > li")).toHaveCount(3);
  fail = true;
  await page.clock.runFor(5_100);
  await expect(log).toContainText("Showing the last events received. Updates will retry.");
  await expect(page.getByText("Feed unavailable", { exact: true })).toBeVisible();
  await expect(log.locator("ol > li")).toHaveCount(3);
});

test("the Board and Room tabs switch with arrow keys and the Room tab shows the connected room", async ({ page }) => {
  await mockOfficeFeed(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  const boardTab = page.getByRole("tab", { name: "Board", exact: true });
  const roomTab = page.getByRole("tab", { name: "Room", exact: true });
  await expect(boardTab).toHaveAttribute("aria-selected", "true");
  await boardTab.focus();

  await page.keyboard.press("ArrowRight");
  await expect(roomTab).toHaveAttribute("aria-selected", "true");
  await expect(roomTab).toBeFocused();
  await expect(boardTab).toHaveAttribute("aria-selected", "false");
  await expect(page.locator("#office-panel-board")).toBeHidden();
  await expect(page.locator('canvas[aria-label^="Woodland"]')).toBeVisible();
  await expect(page.locator("#office-panel-room").getByRole("status")).toContainText("Replay");

  await page.keyboard.press("ArrowRight");
  await expect(boardTab).toHaveAttribute("aria-selected", "true");
  await expect(boardTab).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(roomTab).toHaveAttribute("aria-selected", "true");
});

test("switching Board to Room and back renders the board again with its data", async ({ page }) => {
  await mockOfficeFeed(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  await expect(boardPanel(page).getByRole("heading", { level: 3 })).toHaveCount(5);
  await expect(activityRegion(page).locator("ol > li")).toHaveCount(3);

  await page.getByRole("tab", { name: "Room", exact: true }).click();
  await expect(page.locator('canvas[aria-label^="Woodland"]')).toBeVisible();
  await expect(boardPanel(page)).toBeHidden();

  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(boardPanel(page).getByRole("heading", { level: 3 })).toHaveCount(5);
  await expect(boardPanel(page).locator("li").filter({ hasText: "Seat 1" })).toContainText("Idle");
  await expect(activityRegion(page).locator("ol > li")).toHaveCount(3);
  await expect(activityRegion(page)).toContainText("Merged");
});

test("the board fits 320px without sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockOfficeFeed(page, freshBootstrap);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/office");
  await expect(activityRegion(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
