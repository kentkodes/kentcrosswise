// P2-16: the public office feed. Previews and local runs have the synthetic seed (packages/db
// seeds/agents.ts): one public task, one private task with a title, one public task without a title.
import { expect, test } from "@playwright/test";

const FIELDS = ["agent", "id", "title", "ts", "type"];
// A preview (or the local run) has a database; a prod target may not, and then degrades.
const expectDb = !!process.env.KCW_E2E_LOGIN;

interface Feed {
  available: boolean;
  events: Record<string, unknown>[];
  note?: string;
}

test("the feed API returns only id, ts, agent, type and title, with cache headers", async ({ request }) => {
  const res = await request.get("/api/public/agent-events");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("s-maxage=5");
  const feed = (await res.json()) as Feed;
  if (expectDb) expect(feed.available, feed.note).toBe(true);
  if (!feed.available) {
    expect(feed.events).toEqual([]);
    expect(feed.note).toBeTruthy();
    return;
  }
  expect(feed.events.length).toBeGreaterThan(0);
  for (const e of feed.events) expect(Object.keys(e).sort()).toEqual(FIELDS);
  const titles = new Set(feed.events.map((e) => e.title));
  expect(titles).toContain("Private task");
  expect(titles).toContain("Add a health check page");
  const body = JSON.stringify(feed);
  expect(body).not.toContain("[seed]");
  expect(body).not.toContain("Seed private title");

  const last = feed.events.at(-1)!.id as number;
  const after = (await (await request.get(`/api/public/agent-events?since=${last}`)).json()) as Feed;
  expect(after.events.every((e) => (e.id as number) > last)).toBe(true);
});

test("a bad cursor is a 400", async ({ request }) => {
  const res = await request.get("/api/public/agent-events?since=abc");
  expect(res.status()).toBe(400);
});

test("the office page lists the events as text", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Agent office" }).click();
  await expect(page).toHaveURL(/\/office$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agent office" })).toBeVisible();
  const items = page.getByTestId("agent-events").locator("li");
  if (!expectDb) {
    await expect(items.first().or(page.getByRole("status"))).toBeVisible();
    return;
  }
  await expect(items.first()).toBeVisible();
  await expect(page.getByText("Add a health check page").first()).toBeVisible();
  await expect(page.getByText("Private task").first()).toBeVisible();
  const first = items.first();
  await expect(first.locator("time")).toHaveCount(1);
  await expect(first.locator("[data-field]")).toHaveCount(3);
  await expect(page.getByText("Seed private title")).toHaveCount(0);
  await expect(page.getByText("[seed]")).toHaveCount(0);
});
