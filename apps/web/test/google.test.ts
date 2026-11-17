import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createFakeSecrets, setDefaultSecretStore } from "@kcw/secrets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthConfig, GOOGLE_CALENDAR_SCOPE, GOOGLE_CONNECT_SCOPES } from "../src/auth/config";
import {
  disconnectGoogle,
  googleAccessToken,
  googleConnection,
  resetGoogleCache,
  type GoogleConnection,
  type GoogleDeps,
  type StoredGoogleToken,
} from "../src/server/google";

vi.mock("../src/app/(owner)/connections/actions", () => ({
  connectGoogleAction: async () => {},
  disconnectGoogleAction: async () => {},
}));
const { ConnectionView } = await import("../src/app/(owner)/connections/connection-view");

const CONSENT = `openid email profile ${GOOGLE_CALENDAR_SCOPE}`;
const SECRET_TOKEN = "synthetic-refresh-token";
const SETTINGS = { authSecret: "s".repeat(40), ownerEmail: "o@example.com" };

describe("events.signIn stores the Google refresh token", () => {
  const run = async (account: unknown, secretName: string | undefined = "kcw/test/google") => {
    const patch = vi.fn(async (_name: string, _values: Readonly<Record<string, string>>) => {});
    const cfg = buildAuthConfig(SETTINGS, [], undefined, {
      secretName,
      patch,
      now: () => new Date("2026-11-15T10:00:00Z"),
    });
    await (cfg.events!.signIn as (m: unknown) => Promise<void>)({ account, user: {} });
    return patch;
  };

  it("writes refresh_token, scope and connected_at for a full consent", async () => {
    const patch = await run({ provider: "google", refresh_token: SECRET_TOKEN, scope: CONSENT });
    expect(patch).toHaveBeenCalledWith("kcw/test/google", {
      refresh_token: SECRET_TOKEN,
      scope: CONSENT,
      connected_at: "2026-11-15T10:00:00.000Z",
    });
  });

  it("writes nothing without a refresh token, with a missing scope, for another provider or without a secret name", async () => {
    expect(await run({ provider: "google", scope: CONSENT })).not.toHaveBeenCalled();
    expect(await run({ provider: "google", refresh_token: "t", scope: "openid email profile" })).not.toHaveBeenCalled();
    expect(await run({ provider: "preview", refresh_token: "t", scope: CONSENT })).not.toHaveBeenCalled();
    expect(await run({ provider: "google", refresh_token: "t", scope: CONSENT }, "")).not.toHaveBeenCalled();
  });

  it("logs only the error class when the write fails, and does not throw", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = buildAuthConfig(SETTINGS, [], undefined, {
      secretName: "n",
      patch: async () => {
        throw Object.assign(new Error(`leak ${SECRET_TOKEN}`), { name: "SecretAccessError" });
      },
    });
    await (cfg.events!.signIn as (m: unknown) => Promise<void>)({
      account: { provider: "google", refresh_token: SECRET_TOKEN, scope: CONSENT },
    });
    expect(err.mock.calls).toEqual([["[google] store failed SecretAccessError"]]);
    err.mockRestore();
  });

  it("asks for the Calendar scope and nothing else beyond sign-in", () => {
    expect(GOOGLE_CONNECT_SCOPES.split(" ")).toEqual(["openid", "email", "profile", GOOGLE_CALENDAR_SCOPE]);
  });
});

function fakeStore(initial: StoredGoogleToken | null) {
  let state = initial ? { ...initial } : null;
  const patches: Record<string, string>[] = [];
  return {
    patches,
    read: async () => (state ? { ...state } : null),
    patch: async (p: Readonly<Record<string, string>>) => {
      patches.push({ ...p });
      if (state) {
        state = {
          refreshToken: p.refresh_token ?? state.refreshToken,
          scope: p.scope ?? state.scope,
          connectedAt: p.connected_at ?? state.connectedAt,
        };
      }
    },
  };
}

const stored: StoredGoogleToken = { refreshToken: SECRET_TOKEN, scope: CONSENT, connectedAt: "2026-11-15T10:00:00.000Z" };
const client = async () => ({ clientId: "id.example.invalid", clientSecret: "synthetic-client-secret" });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("googleAccessToken", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetGoogleCache();
    log = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => log.mockRestore());

  it("refreshes once and caches until a minute before expiry", async () => {
    let t = 1_000_000;
    const fetch = vi.fn(async () => json(200, { access_token: "at-1", expires_in: 3600 }));
    const deps: GoogleDeps = { fetch: fetch as never, store: fakeStore(stored), client, now: () => t };
    expect(await googleAccessToken("calendar", deps)).toBe("at-1");
    expect(await googleAccessToken("calendar", deps)).toBe("at-1");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.body.get("grant_type")).toBe("refresh_token");
    expect(init.body.get("refresh_token")).toBe(SECRET_TOKEN);
    t += (3600 - 61) * 1000;
    await googleAccessToken("calendar", deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 2000;
    await googleAccessToken("calendar", deps);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns null when not connected, scope missing or no client, without calling Google", async () => {
    const fetch = vi.fn();
    const base = { fetch: fetch as never, client };
    expect(await googleAccessToken("calendar", { ...base, store: fakeStore(null) })).toBeNull();
    expect(await googleAccessToken("calendar", { ...base, store: fakeStore({ ...stored, refreshToken: "" }) })).toBeNull();
    const noCalendar = fakeStore({ ...stored, scope: "openid email profile" });
    expect(await googleAccessToken("calendar", { ...base, store: noCalendar })).toBeNull();
    expect(await googleAccessToken("calendar", { ...base, store: fakeStore(stored), client: async () => null })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears the refresh token on invalid_grant and logs only the fixed code", async () => {
    const store = fakeStore(stored);
    const fetch = vi.fn(async () => json(400, { error: "invalid_grant", error_description: "secret detail" }));
    expect(await googleAccessToken("calendar", { fetch: fetch as never, store, client })).toBeNull();
    expect(store.patches).toEqual([{ refresh_token: "" }]);
    expect(log.mock.calls).toEqual([["[google] google_token_invalid"]]);
    expect((await googleConnection({ store, client })).expired).toBe(true);
  });

  it("returns null and keeps the token on other failures", async () => {
    const store = fakeStore(stored);
    const fetch = vi.fn(async () => json(500, { error: "backend_error" }));
    expect(await googleAccessToken("calendar", { fetch: fetch as never, store, client })).toBeNull();
    expect(store.patches).toEqual([]);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET_TOKEN);
  });
});

describe("disconnectGoogle and googleConnection", () => {
  beforeEach(resetGoogleCache);

  it("revokes the token, then clears the stored values", async () => {
    const store = fakeStore(stored);
    const fetch = vi.fn(async () => new Response("", { status: 200 }));
    expect(await disconnectGoogle({ fetch: fetch as never, store, client })).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.body.get("token")).toBe(SECRET_TOKEN);
    expect(store.patches).toEqual([{ refresh_token: "", scope: "", connected_at: "" }]);
    expect(await googleConnection({ store, client })).toMatchObject({ connected: false, expired: false, connectedAt: null });
  });

  it("keeps the token when the revoke fails, and does nothing when not connected", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore(stored);
    expect(await disconnectGoogle({ fetch: (async () => new Response("", { status: 503 })) as never, store, client })).toBe(false);
    expect(store.patches).toEqual([]);
    const fetch = vi.fn();
    expect(await disconnectGoogle({ fetch: fetch as never, store: fakeStore(null), client })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("reports connection state", async () => {
    expect(await googleConnection({ store: fakeStore(stored), client })).toEqual({
      configured: true,
      connected: true,
      scopes: ["calendar"],
      connectedAt: stored.connectedAt,
      expired: false,
    });
    expect(await googleConnection({ store: fakeStore(stored), client: async () => null })).toMatchObject({
      configured: false,
      connected: false,
    });
  });
});

describe("ConnectionView states", () => {
  const html = (conn: Partial<GoogleConnection>, confirming = false) =>
    renderToStaticMarkup(
      createElement(ConnectionView, {
        conn: { configured: true, connected: false, scopes: [], connectedAt: null, expired: false, ...conn },
        confirming,
      }),
    );
  const connected: Partial<GoogleConnection> = {
    connected: true,
    scopes: ["calendar"],
    connectedAt: stored.connectedAt,
  };

  it("preview: Not connected, explains it is not configured, no buttons", () => {
    const out = html({ configured: false });
    expect(out).toContain("Not connected");
    expect(out).toContain("Google is not configured here");
    expect(out).not.toContain("<button");
  });

  it("configured but not connected: Connect button only", () => {
    const out = html({});
    expect(out).toContain("Connect Google");
    expect(out).not.toContain("Disconnect");
  });

  it("connected: scopes with the date and a Disconnect link; confirmation shows the confirm button", () => {
    const out = html(connected);
    expect(out).toContain("Connected");
    expect(out).toContain("granted since Nov 15, 10:00 UTC");
    expect(out).toContain("Disconnect");
    expect(out).not.toContain("Yes, disconnect");
    expect(html(connected, true)).toContain("Yes, disconnect");
  });

  it("expired: asks to connect again", () => {
    expect(html({ expired: true, connectedAt: stored.connectedAt })).toContain("Reconnect Google");
  });
});

describe("a secret container with no value yet", () => {
  const NAME = "kcw/test/google-empty";
  afterEach(() => {
    setDefaultSecretStore(undefined);
    delete process.env.KCW_GOOGLE_TOKEN_SECRET;
  });

  it("first consent creates the value; a later one merges into it", async () => {
    const { store, aws } = createFakeSecrets();
    setDefaultSecretStore(store);
    const cfg = buildAuthConfig(SETTINGS, [], undefined, { secretName: NAME, now: () => new Date("2026-11-15T10:00:00Z") });
    const account = { provider: "google", refresh_token: SECRET_TOKEN, scope: CONSENT };
    await (cfg.events!.signIn as (m: unknown) => Promise<void>)({ account });
    expect(JSON.parse(aws.values.get(NAME)!)).toEqual({
      refresh_token: SECRET_TOKEN,
      scope: CONSENT,
      connected_at: "2026-11-15T10:00:00.000Z",
    });
    await (cfg.events!.signIn as (m: unknown) => Promise<void>)({ account: { ...account, refresh_token: "second" } });
    expect(JSON.parse(aws.values.get(NAME)!).refresh_token).toBe("second");
  });

  it("another error class is only logged by class and nothing is created", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { store, aws } = createFakeSecrets();
    setDefaultSecretStore(store);
    aws.failNextWith = "AccessDeniedException";
    const cfg = buildAuthConfig(SETTINGS, [], undefined, { secretName: NAME });
    await (cfg.events!.signIn as (m: unknown) => Promise<void>)({
      account: { provider: "google", refresh_token: SECRET_TOKEN, scope: CONSENT },
    });
    expect(log.mock.calls).toEqual([["[google] store failed SecretAccessError"]]);
    expect(aws.values.has(NAME)).toBe(false);
    log.mockRestore();
  });

  it("reading it reports not connected, not an error", async () => {
    const { store } = createFakeSecrets();
    setDefaultSecretStore(store);
    process.env.KCW_GOOGLE_TOKEN_SECRET = NAME;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const conn = await googleConnection({ client });
    expect(conn).toEqual({ configured: true, connected: false, scopes: [], connectedAt: null, expired: false });
    expect(await googleAccessToken("calendar", { client })).toBeNull();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
