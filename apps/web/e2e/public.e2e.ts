import { expect, test } from "@playwright/test";

test("public home renders and links to the demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /A little space\s*for your everyday\./ })).toBeVisible();
  await expect(page.getByText(/^Simulated data/)).toBeVisible();
  await page.getByRole("main").getByRole("link", { name: "Explore the demo", exact: true }).click();
  await expect(page).toHaveURL(/\/demo$/);
});

test("demo page shows simulated data", async ({ page }) => {
  await page.goto("/demo");
  await expect(page.getByRole("heading", { level: 1, name: "Demo" })).toBeVisible();
  await expect(page.getByText("Everything on this page is simulated")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Contacts" })).toBeVisible();
});
