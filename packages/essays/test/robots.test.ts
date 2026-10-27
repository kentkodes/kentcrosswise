import { describe, expect, it } from "vitest";
import {
  RobotsCache, interpretRobots, parseRobots, productToken, robotsAllows, robotsCrawlDelayMs, type RobotsFetch,
} from "../src/crawl/robots";

const UA = "KentcrosswiseBot/1.0 (+https://example.com/bot)";
const allows = (txt: string, path: string) => robotsAllows(parseRobots(txt), UA, path);
const NOW = new Date("2026-10-27T00:00:00Z");

describe("robots parsing (RFC 9309)", () => {
  it("extracts the product token", () => {
    expect(productToken(UA)).toBe("kentcrosswisebot");
  });

  it("allows everything with no rules and with an empty Disallow", () => {
    expect(allows("", "/a")).toBe(true);
    expect(allows("User-agent: *\nDisallow:\n", "/a")).toBe(true);
  });

  it("disallows by prefix", () => {
    const txt = "User-agent: *\nDisallow: /private\n";
    expect(allows(txt, "/private")).toBe(false);
    expect(allows(txt, "/private/x?y=1")).toBe(false);
    expect(allows(txt, "/public")).toBe(true);
  });

  it("supports * wildcards and the $ anchor", () => {
    const txt = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /search*q=\n";
    expect(allows(txt, "/files/a.pdf")).toBe(false);
    expect(allows(txt, "/files/a.pdf?x=1")).toBe(true);
    expect(allows(txt, "/search?q=1")).toBe(false);
    expect(allows(txt, "/search?p=1")).toBe(true);
  });

  it("longest match wins and Allow wins a tie", () => {
    const txt = "User-agent: *\nDisallow: /ebooks/\nAllow: /ebooks/12\n";
    expect(allows(txt, "/ebooks/12")).toBe(true);
    expect(allows(txt, "/ebooks/13")).toBe(false);
    expect(allows("User-agent: *\nDisallow: /a\nAllow: /a\n", "/a")).toBe(true);
  });

  it("prefers the group for our token over *", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: KentcrosswiseBot\nAllow: /\nDisallow: /secret\n";
    expect(allows(txt, "/open")).toBe(true);
    expect(allows(txt, "/secret")).toBe(false);
  });

  it("applies a shared group to every listed agent, case-insensitively", () => {
    const txt = "user-agent: otherbot\nUSER-AGENT: KENTCROSSWISEBOT\nDisallow: /x\n";
    expect(allows(txt, "/x")).toBe(false);
    expect(allows(txt, "/y")).toBe(true);
  });

  it("ignores comments, CRLF, a BOM and unknown fields", () => {
    const txt =
      String.fromCharCode(0xfeff) +
      "User-agent: * # all\r\nSitemap: https://example.com/s.xml\r\nDisallow: /x # no\r\nHost: example.com\r\n";
    expect(allows(txt, "/x")).toBe(false);
    expect(allows(txt, "/y")).toBe(true);
  });

  it("always allows /robots.txt itself", () => {
    expect(allows("User-agent: *\nDisallow: /\n", "/robots.txt")).toBe(true);
  });

  it("matches percent-encoded paths case-insensitively in the hex", () => {
    expect(allows("User-agent: *\nDisallow: /caf%c3%a9\n", "/caf%C3%A9")).toBe(false);
  });

  it("reads Crawl-delay in seconds for our group, else *", () => {
    expect(robotsCrawlDelayMs(parseRobots("User-agent: *\nCrawl-delay: 10\n"), UA)).toBe(10_000);
    const both = "User-agent: *\nCrawl-delay: 10\n\nUser-agent: kentcrosswisebot\nCrawl-delay: 1.5\n";
    expect(robotsCrawlDelayMs(parseRobots(both), UA)).toBe(1500);
    expect(robotsCrawlDelayMs(parseRobots("User-agent: *\nDisallow: /x\n"), UA)).toBe(0);
  });
});

describe("robots fetch interpretation (fail closed)", () => {
  const res = (status: number, body = ""): RobotsFetch => ({ kind: "response", status, body });
  const allowed = (r: RobotsFetch) => robotsAllows(interpretRobots(r, NOW).parsed, UA, "/ebooks/1");

  it("200 uses the rules and records a sha256", () => {
    const p = interpretRobots(res(200, "User-agent: *\nDisallow: /ebooks\n"), NOW);
    expect(p.status).toBe("ok");
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(robotsAllows(p.parsed, UA, "/ebooks/1")).toBe(false);
  });

  it("404 and 410 allow", () => {
    expect(allowed(res(404))).toBe(true);
    expect(allowed(res(410))).toBe(true);
    expect(interpretRobots(res(404), NOW).status).toBe("not_found");
  });

  it("401 and 403 disallow", () => {
    expect(allowed(res(401))).toBe(false);
    expect(allowed(res(403))).toBe(false);
    expect(interpretRobots(res(403), NOW)).toMatchObject({ status: "forbidden", cacheable: true });
  });

  it("5xx, 429, redirects, timeouts and network errors disallow for the run only", () => {
    const cases: RobotsFetch[] = [res(500), res(503), res(429), res(302), { kind: "error", reason: "timeout" }];
    for (const r of cases) {
      const p = interpretRobots(r, NOW);
      expect(robotsAllows(p.parsed, UA, "/ebooks/1")).toBe(false);
      expect(p).toMatchObject({ status: "unreachable", cacheable: false });
    }
  });
});

describe("RobotsCache", () => {
  const okFetch = async (): Promise<RobotsFetch> => ({ kind: "response", status: 200, body: "User-agent: *\nDisallow: /x\n" });

  it("caches for 24 h", async () => {
    const cache = new RobotsCache();
    let loads = 0;
    const load = async () => {
      loads += 1;
      return okFetch();
    };
    await cache.getOrLoad("https://example.com", NOW, load);
    await cache.getOrLoad("https://example.com", new Date(NOW.getTime() + 23 * 3600_000), load);
    expect(loads).toBe(1);
    await cache.getOrLoad("https://example.com", new Date(NOW.getTime() + 24 * 3600_000), load);
    expect(loads).toBe(2);
  });

  it("keeps a fail-closed result for the run but refetches in the next run", async () => {
    const cache = new RobotsCache();
    let loads = 0;
    const bad = async (): Promise<RobotsFetch> => {
      loads += 1;
      return { kind: "response", status: 503, body: "" };
    };
    await cache.getOrLoad("https://example.com", NOW, bad);
    await cache.getOrLoad("https://example.com", NOW, bad);
    expect(loads).toBe(1);
    cache.startRun();
    await cache.getOrLoad("https://example.com", NOW, okFetch);
    expect(cache.get("https://example.com", NOW)?.status).toBe("ok");
  });

  it("keeps cacheable policies across runs", async () => {
    const cache = new RobotsCache();
    await cache.getOrLoad("https://example.com", NOW, okFetch);
    cache.startRun();
    expect(cache.get("https://example.com", NOW)?.status).toBe("ok");
  });
});
