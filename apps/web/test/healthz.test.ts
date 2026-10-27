import { describe, expect, it } from "vitest";
import { GET } from "../src/app/healthz/route";

describe("GET /healthz", () => {
  it("returns 200, body ok and text/plain", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("ok");
  });
});
