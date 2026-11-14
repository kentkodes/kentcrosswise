// captureAction is a POST endpoint of its own: it must check the owner before it reads the form,
// and it must redirect with a fixed notice code (never the entry text).
import { afterEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  withDb: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: f.redirect }));
vi.mock("@/server/owner", () => ({ requireOwner: f.requireOwner }));
// The '@/' alias does not resolve under this vitest setup for these imports, so each mock loads the real
// module by relative path and overrides only what the action needs.
vi.mock("@/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("../src/server/db", async () => ({ ...(await import("../src/server/db")), withDb: f.withDb }));
vi.mock("@/server/capture", async () => await import("../src/server/capture"));
vi.mock("@/server/console", async () => await import("../src/server/console"));

import { captureAction } from "../src/app/(owner)/hub/actions";

function form(raw: string): FormData {
  const data = new FormData();
  data.set("raw_text", raw);
  return data;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("captureAction", () => {
  it("stops before reading or storing anything when the caller is not the owner", async () => {
    f.requireOwner.mockRejectedValueOnce(new Error("NEXT_REDIRECT /api/auth/signin"));
    await expect(captureAction(form("private thought"))).rejects.toThrow("NEXT_REDIRECT");
    expect(f.requireOwner).toHaveBeenCalledOnce();
    expect(f.withDb).not.toHaveBeenCalled();
    expect(f.redirect).not.toHaveBeenCalled();
  });

  it("redirects with capture-empty and stores nothing for a whitespace-only submit", async () => {
    await captureAction(form(" \r\n\t "));
    expect(f.requireOwner).toHaveBeenCalledOnce();
    expect(f.withDb).not.toHaveBeenCalled();
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/hub?n=capture-empty");
  });

  it("redirects with capture-too-long and stores nothing over 10000 characters", async () => {
    await captureAction(form("x".repeat(10001)));
    expect(f.withDb).not.toHaveBeenCalled();
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/hub?n=capture-too-long");
  });

  it("saves through web_rw and redirects with captured", async () => {
    f.withDb.mockResolvedValueOnce("entry-id");
    await captureAction(form("line one\r\nline two"));
    expect(f.withDb).toHaveBeenCalledExactlyOnceWith("web_rw", expect.any(Function));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/hub?n=captured");
  });

  it("maps a DB failure to the db-error notice without putting the text in the URL or the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    f.withDb.mockRejectedValueOnce(Object.assign(new Error("insert failed for private text"), { name: "Error", code: "42501" }));
    await captureAction(form("private thought"));
    expect(f.redirect).toHaveBeenCalledExactlyOnceWith("/hub?n=db-error");
    expect(log).toHaveBeenCalledExactlyOnceWith("[hub] Error 42501");
  });
});
