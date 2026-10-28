import { describe, expect, it } from "vitest";
import { createHttpClient, fetchRobotsTxt } from "../src/crawl/http";
import {
  MAX_ROBOTS_BYTES, RobotsCache, interpretRobots, parseRobots, productToken, robotsAllows, robotsCrawlDelayMs,
  robotsPatternMatches, type RobotsFetch,
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

describe("robots wildcard matching (linear, no regex)", () => {
  /** The former regex compilation, kept here only as a reference oracle for short inputs. */
  function regexOracle(pattern: string, path: string): boolean {
    const anchored = pattern.endsWith("$");
    const core = anchored ? pattern.slice(0, -1) : pattern;
    const body = core.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
  }

  it("keeps * / $ semantics: literal $ mid-pattern, bare $, trailing *$ and leading *", () => {
    expect(robotsPatternMatches("/a*b*c", "/aXbYc/z")).toBe(true);
    expect(robotsPatternMatches("/a*b*c", "/aXcYb")).toBe(false);
    expect(robotsPatternMatches("/a$b", "/a$b/x")).toBe(true);
    expect(robotsPatternMatches("/a$b", "/ab")).toBe(false);
    expect(robotsPatternMatches("/$", "/")).toBe(true);
    expect(robotsPatternMatches("/$", "/x")).toBe(false);
    expect(robotsPatternMatches("/x*$", "/x/anything")).toBe(true);
    expect(robotsPatternMatches("*.pdf$", "/a.pdf")).toBe(true);
    expect(robotsPatternMatches("/*ab*ab$", "/abab")).toBe(true);
    expect(robotsPatternMatches("/*ab*ab$", "/ab")).toBe(false);
    expect(robotsPatternMatches("/*aa$", "/aaa")).toBe(true);
  });

  it("agrees with the former regex semantics on an exhaustive small table", () => {
    // Deterministic PRNG over a tiny alphabet so every edge (overlaps, empty pieces) shows up.
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    const word = (alphabet: string, max: number) => Array.from({ length: rnd(max) }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let i = 0; i < 5000; i++) {
      const pattern = `/${word("ab*$", 7)}`;
      const path = `/${word("ab$", 8)}`;
      expect(robotsPatternMatches(pattern, path), `${pattern} vs ${path}`).toBe(regexOracle(pattern, path));
    }
  });

  it("keeps longest-match precedence with wildcard rules", () => {
    const txt = "User-agent: *\nAllow: /*.html$\nDisallow: /private/\n";
    expect(allows(txt, "/private/a.html")).toBe(false); // "/private/" (9) beats "/*.html$" (8)
    expect(allows(txt, "/public/a.html")).toBe(true);
    expect(allows(`${txt}Allow: /private/*.html$\n`, "/private/a.html")).toBe(true);
  });

  it("a rule with many wildcards against a long path completes quickly", () => {
    const txt = `User-agent: *\nDisallow: /${"*a".repeat(16)}*b$\n`;
    const path = `/${"a".repeat(20_000)}c`;
    const started = performance.now();
    expect(allows(txt, path)).toBe(true);
    expect(allows(txt, `${path}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("oversized robots.txt fails closed", () => {
  const SIX_MB = 6 * 1024 * 1024;
  const huge = () => `User-agent: *\nDisallow: /\n${"# padding\n".repeat(SIX_MB / 10)}`;

  it("a 6 MB `Disallow: /` body disallows everything for the run only", () => {
    const p = interpretRobots({ kind: "response", status: 200, body: huge() }, NOW);
    expect(robotsAllows(p.parsed, UA, "/ebooks/1")).toBe(false);
    expect(p).toMatchObject({ status: "unreachable", cacheable: false });
  });

  it("never truncates: a disallow after 500 KiB still wins over an earlier allow", () => {
    const body = `User-agent: *\nAllow: /\n${"#".repeat(MAX_ROBOTS_BYTES)}\nDisallow: /private\n`;
    expect(robotsAllows(interpretRobots({ kind: "response", status: 200, body }, NOW).parsed, UA, "/private/1")).toBe(false);
  });

  it.each([["default cap", undefined], ["catalog-sized cap", 64 * 1024 * 1024]])(
    "fetchRobotsTxt maps an oversized 200 to an error (%s)",
    async (_label, maxBodyBytes) => {
      const client = createHttpClient({ fetch: async () => new Response(huge()), maxRetries: 0,
        ...(maxBodyBytes !== undefined && { maxBodyBytes }) });
      const fetched = await fetchRobotsTxt(client, "https://example.com");
      expect(fetched).toEqual({ kind: "error", reason: "too_large" });
      expect(robotsAllows(interpretRobots(fetched, NOW).parsed, UA, "/ebooks/1")).toBe(false);
    },
  );

  it("fetchRobotsTxt keeps status-carrying failures as responses (404 allows, 403 disallows)", async () => {
    const at = (status: number) => createHttpClient({ fetch: async () => new Response("", { status }), maxRetries: 0 });
    expect(await fetchRobotsTxt(at(404), "https://example.com")).toEqual({ kind: "response", status: 404, body: "" });
    expect(await fetchRobotsTxt(at(403), "https://example.com")).toEqual({ kind: "response", status: 403, body: "" });
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
