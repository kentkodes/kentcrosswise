// PL7: the demo calendar consent. A separate OAuth flow for the dummy Google account: state and PKCE in a one-use
// cookie, the owner's own account refused (its token revoked, nothing stored), the token stored only with the calendar
// scope and a refresh token; and the /connections region. Synthetic addresses and tokens only.
import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_CALENDAR_SCOPE } from "../src/auth/google-consent";
import { finishDemoConsent, readConsentCookie, siteOrigin, startDemoConsent } from "../src/server/demo-consent";
import type { DemoCalendarStatus } from "../src/server/demo-calendar";
import type { GoogleConnection } from "../src/server/google";

vi.mock("../src/app/(owner)/connections/actions", () => ({
  connectGoogleAction: async () => {},
  disconnectGoogleAction: async () => {},
  connectDemoCalendarAction: async () => {},
  disconnectDemoCalendarAction: async () => {},
  syncDemoCalendarAction: async () => {},
}));
const { DemoCalendarView } = await import("../src/app/(owner)/connections/connection-view");
const { handleDemoCallback } = await import("../src/app/(owner)/connections/demo-callback");
const { CONNECTION_NOTICES } = await import("../src/app/(owner)/connections/notices");

vi.spyOn(console, "error").mockImplementation(() => undefined);

const SETTINGS = { clientId: "synthetic-client", clientSecret: "synthetic-secret", ownerEmail: "owner@example.com" };
const REDIRECT = "https://example.test/connections/demo/callback";
const idToken = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });

type Call = { url: string; body: URLSearchParams };
function google(tokenReply: Record<string, unknown>, status = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: new URLSearchParams(String(init.body)) });
    return url.includes("/token") ? new Response(JSON.stringify(tokenReply), { status }) : new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetch: f };
}
const reply = (over: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) => ({
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  scope: `openid ${GOOGLE_CALENDAR_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
  id_token: idToken({ email: "demo.calendar@example.com", email_verified: true, ...claims }),
  ...over,
});

describe("starting the demo consent", () => {
  it("uses the viewer host, https except on localhost, and refuses an odd host", () => {
    expect(siteOrigin(headers({ "x-forwarded-host": "kcw.example.com", host: "lambda.example" }))).toBe("https://kcw.example.com");
    expect(siteOrigin(headers({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(siteOrigin(headers({ host: "evil.example/path" }))).toBeNull();
    expect(siteOrigin(headers({}))).toBeNull();
  });

  it("asks for the address and calendar events, with the account chooser, a state and an S256 challenge", () => {
    const s = startDemoConsent("synthetic-client", REDIRECT);
    const url = new URL(s.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "synthetic-client",
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: `openid email ${GOOGLE_CALENDAR_SCOPE}`,
      access_type: "offline",
      prompt: "consent select_account",
      state: s.state,
      code_challenge: createHash("sha256").update(s.verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    expect(readConsentCookie(s.cookie)).toEqual({ state: s.state, verifier: s.verifier });
    expect(startDemoConsent("synthetic-client", REDIRECT).state).not.toBe(s.state);
    expect(readConsentCookie("bad")).toBeNull();
    expect(readConsentCookie(undefined)).toBeNull();
  });
});

describe("finishDemoConsent", () => {
  const finish = (g: ReturnType<typeof google>, patch = vi.fn(async () => {})) =>
    finishDemoConsent({ code: "synthetic-code", verifier: "v".repeat(64), redirectUri: REDIRECT }, SETTINGS, { fetch: g.fetch, patch, now: () => new Date("2026-11-19T12:00:00Z") });

  it("stores the refresh token and returns the calendar id", async () => {
    const g = google(reply());
    const patch = vi.fn(async () => {});
    await expect(finish(g, patch)).resolves.toEqual({ outcome: "connected", calendarId: "demo.calendar@example.com" });
    expect(Object.fromEntries(g.calls[0]!.body)).toMatchObject({ grant_type: "authorization_code", code_verifier: "v".repeat(64), redirect_uri: REDIRECT });
    expect(patch).toHaveBeenCalledWith({ refresh_token: "synthetic-refresh", scope: expect.stringContaining(GOOGLE_CALENDAR_SCOPE), connected_at: "2026-11-19T12:00:00.000Z" });
    expect(g.calls).toHaveLength(1); // no revoke
  });

  it.each([
    ["the owner's own account", reply({}, { email: "Owner@Example.com" }), "owner-account"],
    ["an unverified address", reply({}, { email_verified: false }), "unverified"],
    ["no address", reply({ id_token: undefined }), "unverified"],
    ["no calendar scope", reply({ scope: "openid email" }), "no-calendar"],
    ["no refresh token", reply({ refresh_token: undefined }), "no-token"],
  ])("refuses %s, revokes what it got and stores nothing", async (_name, body, outcome) => {
    const g = google(body);
    const patch = vi.fn(async () => {});
    await expect(finish(g, patch)).resolves.toEqual({ outcome });
    expect(patch).not.toHaveBeenCalled();
    expect(g.calls.map((c) => c.url)).toEqual(["https://oauth2.googleapis.com/token", "https://oauth2.googleapis.com/revoke"]);
  });

  it("reports a failed exchange or store without throwing", async () => {
    await expect(finish(google({ error: "invalid_grant" }, 400))).resolves.toEqual({ outcome: "failed" });
    const g = google(reply());
    await expect(finish(g, vi.fn(async () => Promise.reject(new Error("synthetic"))))).resolves.toEqual({ outcome: "failed" });
    expect(g.calls.at(-1)!.url).toBe("https://oauth2.googleapis.com/revoke");
  });
});

describe("handleDemoCallback", () => {
  const start = startDemoConsent("synthetic-client", REDIRECT);
  const params = (p: Record<string, string>) => new URLSearchParams({ state: start.state, ...p });
  const deps = (g = google(reply())) => ({ fetch: g.fetch, patch: vi.fn(async () => {}), settings: async () => SETTINGS, save: vi.fn(async () => {}), sync: vi.fn(async () => "synced") });

  it("connects: stores the token and the calendar id, then syncs everything", async () => {
    const d = deps();
    await expect(handleDemoCallback(params({ code: "synthetic-code" }), start.cookie, REDIRECT, d)).resolves.toBe("demo-connected");
    expect(d.save).toHaveBeenCalledWith("demo.calendar@example.com");
    expect(d.sync).toHaveBeenCalledOnce();
  });

  it("refuses a missing or different state before anything else, and reports a cancelled consent", async () => {
    const d = deps();
    await expect(handleDemoCallback(params({ code: "c" }), undefined, REDIRECT, d)).resolves.toBe("demo-bad-state");
    await expect(handleDemoCallback(new URLSearchParams({ state: "x".repeat(32), code: "c" }), start.cookie, REDIRECT, d)).resolves.toBe("demo-bad-state");
    await expect(handleDemoCallback(params({ error: "access_denied" }), start.cookie, REDIRECT, d)).resolves.toBe("demo-denied");
    await expect(handleDemoCallback(params({}), start.cookie, REDIRECT, d)).resolves.toBe("demo-failed");
    expect(d.patch).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
  });

  it("passes the owner-account refusal through and saves nothing", async () => {
    const d = deps(google(reply({}, { email: "owner@example.com" })));
    await expect(handleDemoCallback(params({ code: "c" }), start.cookie, REDIRECT, d)).resolves.toBe("demo-owner-account");
    expect(d.save).not.toHaveBeenCalled();
  });

  it("has a notice for every outcome it can return", () => {
    for (const code of ["demo-connected", "demo-denied", "demo-bad-state", "demo-owner-account", "demo-unverified", "demo-no-calendar", "demo-no-token", "demo-not-configured", "demo-failed"]) {
      expect(CONNECTION_NOTICES).toHaveProperty(code);
    }
  });
});

describe("the two Google accounts", () => {
  it("read different secrets: the demo calendar is not configured by the owner's token secret", async () => {
    const { demoGoogle, ownerGoogle } = await import("../src/server/google");
    const before = { ...process.env };
    try {
      process.env.KCW_GOOGLE_TOKEN_SECRET = "kcw/test/owner-token";
      delete process.env.KCW_GOOGLE_DEMO_TOKEN_SECRET;
      const client = async () => ({ clientId: "c", clientSecret: "s" });
      expect((await demoGoogle.connection({ client })).configured).toBe(false);
      expect(ownerGoogle.secretEnv).toBe("KCW_GOOGLE_TOKEN_SECRET");
      expect(demoGoogle.secretEnv).toBe("KCW_GOOGLE_DEMO_TOKEN_SECRET");
    } finally {
      process.env = before;
    }
  });
});

describe("DemoCalendarView", () => {
  const conn = (c: Partial<GoogleConnection> = {}): GoogleConnection => ({ configured: true, connected: false, scopes: [], connectedAt: null, expired: false, ...c });
  const status: DemoCalendarStatus = { calendarId: "demo.calendar@example.com", mirrored: 3, lastSyncAt: "2026-11-19T12:00:00.000Z", lastSyncOutcome: "synced" };
  const html = (c: GoogleConnection, s: DemoCalendarStatus | null = null, confirming = false) => renderToStaticMarkup(createElement(DemoCalendarView, { conn: c, status: s, confirming }));

  it("not configured: says so, no buttons", () => {
    const out = html(conn({ configured: false }));
    expect(out).toContain("not configured here");
    expect(out).not.toContain("<button");
  });

  it("configured: Connect only, and says the owner's account is refused", () => {
    const out = html(conn(), { ...status, calendarId: null, mirrored: 0, lastSyncAt: null, lastSyncOutcome: null });
    expect(out).toContain("Connect demo calendar");
    expect(out).toContain("your own account is refused");
    expect(out).toContain("Last sync: none yet");
    expect(out).not.toContain("Sync now");
    expect(out).not.toContain("Open the public calendar");
  });

  it("connected: the calendar, count, last sync, the public link, Sync now and Disconnect with a confirmation", () => {
    const out = html(conn({ connected: true, scopes: ["calendar"] }), status);
    expect(out).toContain("Calendar: demo.calendar@example.com");
    expect(out).toContain("Events mirrored: 3");
    expect(out).toContain("Last sync: Nov 19, 12:00 UTC, in sync");
    expect(out).toContain('href="https://calendar.google.com/calendar/embed?src=demo.calendar%40example.com"');
    expect(out).toContain("Sync now");
    expect(out).toContain("Reconnect demo calendar");
    expect(out).not.toContain("Yes, disconnect");
    expect(html(conn({ connected: true }), status, true)).toContain("Yes, disconnect");
  });

  it("expired: mirroring is paused", () => {
    expect(html(conn({ expired: true }), { ...status, lastSyncOutcome: "reconnect" })).toContain("Mirroring is paused");
  });
});
