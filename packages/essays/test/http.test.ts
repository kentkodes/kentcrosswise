import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_USER_AGENT, createHttpClient, fetchRobotsTxt, looksLikeLoginUrl } from "../src/crawl/http";
import { FakeServer } from "./fake-server";

const server = new FakeServer();
beforeAll(() => server.start());
afterAll(() => server.stop());
beforeEach(() => {
  server.requests.length = 0;
});

function client(extra: Parameters<typeof createHttpClient>[0] = {}) {
  const sleeps: number[] = [];
  const c = createHttpClient({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
    ...extra,
  });
  return { c, sleeps };
}

describe("http client", () => {
  it("sends one User-Agent, no cookies and no credentials", async () => {
    server.route("/ok", (_req, res) => {
      res.writeHead(200, { "set-cookie": "sid=abc", "content-type": "text/plain" });
      res.end("hello");
    });
    const { c } = client();
    const r1 = await c.get(`${server.origin}/ok`);
    const r2 = await c.get(`${server.origin}/ok`);
    expect(r1).toMatchObject({ ok: true, status: 200, body: "hello", attempts: 1 });
    if (r1.ok) expect(r1.headers["set-cookie"]).toBeUndefined();
    const sent = server.requests.map((q) => q.headers);
    expect(sent).toHaveLength(2);
    for (const h of sent) {
      expect(h["user-agent"]).toBe(DEFAULT_USER_AGENT);
      expect(h.cookie).toBeUndefined();
      expect(h.authorization).toBeUndefined();
    }
    expect(r2.ok).toBe(true);
  });

  it("retries 5xx with exponential backoff (2, 4, 8 s) then fails", async () => {
    server.reply("/down", 503);
    const { c, sleeps } = client();
    const r = await c.get(`${server.origin}/down`);
    expect(r).toMatchObject({ ok: false, reason: "http_5xx", status: 503, attempts: 4 });
    expect(sleeps).toEqual([2000, 4000, 8000]);
  });

  it("recovers when a retry succeeds", async () => {
    server.route("/flaky", (_req, res, hit) => {
      res.writeHead(hit < 3 ? 500 : 200);
      res.end("fine");
    });
    const { c } = client();
    expect(await c.get(`${server.origin}/flaky`)).toMatchObject({ ok: true, body: "fine", attempts: 3 });
  });

  it("adds jitter to the backoff", async () => {
    server.reply("/down2", 502);
    const { c, sleeps } = client({ random: () => 0.5 });
    await c.get(`${server.origin}/down2`);
    expect(sleeps).toEqual([2250, 4500, 9000]);
  });

  it("honors Retry-After on 429", async () => {
    server.route("/slow", (_req, res, hit) => {
      if (hit === 1) res.writeHead(429, { "retry-after": "20" });
      else res.writeHead(200);
      res.end("later");
    });
    const { c, sleeps } = client();
    expect(await c.get(`${server.origin}/slow`)).toMatchObject({ ok: true, body: "later", attempts: 2 });
    expect(sleeps).toEqual([20_000]);
  });

  it("does not wait for a very long Retry-After: it fails and reports it", async () => {
    server.reply("/blocked-for-an-hour", 429, "", { "retry-after": "3600" });
    const { c, sleeps } = client();
    const r = await c.get(`${server.origin}/blocked-for-an-hour`);
    expect(r).toMatchObject({ ok: false, reason: "http_429", retryAfterMs: 3_600_000, attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it("does not retry other 4xx", async () => {
    server.reply("/gone", 404);
    const { c, sleeps } = client();
    expect(await c.get(`${server.origin}/gone`)).toMatchObject({ ok: false, reason: "http_4xx", status: 404, attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it("stops at once on 401 and 403", async () => {
    server.reply("/forbidden", 403);
    server.reply("/auth", 401);
    const { c, sleeps } = client();
    expect(await c.get(`${server.origin}/forbidden`)).toMatchObject({ ok: false, reason: "blocked_403", attempts: 1 });
    expect(await c.get(`${server.origin}/auth`)).toMatchObject({ ok: false, reason: "blocked_401", attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it("follows redirects but never into a login page", async () => {
    server.reply("/old", 301, "", { location: "/new" });
    server.reply("/new", 200, "moved");
    server.reply("/wall", 302, "", { location: "/login?next=/wall" });
    server.reply("/login", 200, "<form>");
    const { c } = client();
    expect(await c.get(`${server.origin}/old`)).toMatchObject({ ok: true, body: "moved", url: `${server.origin}/new` });
    expect(await c.get(`${server.origin}/wall`)).toMatchObject({ ok: false, reason: "login_redirect" });
    expect(server.count("/login")).toBe(0);
  });

  it("gives up on redirect loops", async () => {
    server.reply("/a", 302, "", { location: "/b" });
    server.reply("/b", 302, "", { location: "/a" });
    const { c } = client({ maxRedirects: 3 });
    expect(await c.get(`${server.origin}/a`)).toMatchObject({ ok: false, reason: "too_many_redirects" });
  });

  it("rejects a redirect to a non-http scheme", async () => {
    server.reply("/ftp", 302, "", { location: "ftp://example.com/x" });
    const { c } = client();
    expect(await c.get(`${server.origin}/ftp`)).toMatchObject({ ok: false, reason: "bad_redirect" });
  });

  it("caps the body size", async () => {
    server.reply("/big", 200, "x".repeat(2000));
    const { c } = client({ maxBodyBytes: 1000 });
    expect(await c.get(`${server.origin}/big`)).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("retries network errors then reports network_error", async () => {
    const { c, sleeps } = client({ fetch: async () => Promise.reject(new TypeError("fetch failed")), maxRetries: 2 });
    expect(await c.get(`${server.origin}/x`)).toMatchObject({ ok: false, reason: "network_error", attempts: 3 });
    expect(sleeps).toEqual([2000, 4000]);
  });

  it("asks the guard before every request, retries included", async () => {
    server.reply("/g", 500);
    const seen: string[] = [];
    const { c } = client({
      maxRetries: 1,
      guard: async (url) => {
        seen.push(url);
        return { ok: true };
      },
    });
    await c.get(`${server.origin}/g`);
    expect(seen).toHaveLength(2);
  });

  it("makes no request when the guard refuses", async () => {
    const { c } = client({ guard: async () => ({ ok: false, reason: "robots_disallow" }) });
    expect(await c.get(`${server.origin}/never`)).toMatchObject({ ok: false, reason: "guard_refused", detail: "robots_disallow", attempts: 0 });
    expect(server.count("/never")).toBe(0);
  });
});

describe("robots.txt through the client", () => {
  it("maps statuses for interpretation", async () => {
    server.reply("/robots.txt", 200, "User-agent: *\nDisallow: /x\n");
    const { c } = client();
    expect(await fetchRobotsTxt(c, server.origin)).toEqual({ kind: "response", status: 200, body: "User-agent: *\nDisallow: /x\n" });
    server.reply("/robots.txt", 403);
    expect(await fetchRobotsTxt(c, server.origin)).toMatchObject({ kind: "response", status: 403 });
    server.reply("/robots.txt", 404);
    expect(await fetchRobotsTxt(c, server.origin)).toMatchObject({ kind: "response", status: 404 });
    server.reply("/robots.txt", 500);
    expect(await fetchRobotsTxt(c, server.origin)).toMatchObject({ kind: "response", status: 500 });
    server.reply("/robots.txt", 302, "", { location: "/login" });
    expect(await fetchRobotsTxt(c, server.origin)).toMatchObject({ kind: "error" });
  });
});

describe("looksLikeLoginUrl", () => {
  it("flags login hosts and paths only", () => {
    expect(looksLikeLoginUrl("https://accounts.example.com/x")).toBe(true);
    expect(looksLikeLoginUrl("https://example.com/users/login")).toBe(true);
    expect(looksLikeLoginUrl("https://example.com/w/index.php?title=Special:UserLogin")).toBe(false);
    expect(looksLikeLoginUrl("https://example.com/wiki/Special:UserLogin")).toBe(true);
    expect(looksLikeLoginUrl("https://example.com/essays/login-to-the-world")).toBe(false);
  });
});
