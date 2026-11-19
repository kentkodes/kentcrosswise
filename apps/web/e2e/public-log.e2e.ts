// PL4: GET /api/public/log reads through web_public only. Previews hold no published records (routing is off there),
// so this checks the shape: the label, three counts, and records with exactly the public fields.
import { expect, test } from "@playwright/test";

const FIELDS = ["capturedHour", "id", "kind", "steps", "text"];
const expectDb = Boolean(process.env.KCW_E2E_LOGIN); // previews and the local run have a database; prod targets may not

type Log = { available: boolean; label: string; note?: string; diag?: string; counts?: Record<string, number>; records?: Record<string, unknown>[] };

test("the public log API returns the label, the counts and only public record fields, with cache headers", async ({ request }) => {
  const res = await request.get("/api/public/log");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("s-maxage=30");
  const log = (await res.json()) as Log;
  expect(log.label).toBe("Tasks published automatically after sanitization; some records withheld for privacy/security");
  const why = `log unavailable: ${log.note ?? "?"} (diag: ${log.diag ?? "none"}; server log lines start with [public-log] or [db])`;
  if (expectDb) expect(log.available, why).toBe(true);
  if (!log.available) {
    expect(log.note).toBeTruthy();
    return;
  }
  expect(Object.keys(log.counts!).sort()).toEqual(["awaitingReview", "published", "withheld"]);
  for (const n of Object.values(log.counts!)) expect(Number.isInteger(n)).toBe(true);
  for (const r of log.records!) expect(Object.keys(r).sort()).toEqual(FIELDS);
});
