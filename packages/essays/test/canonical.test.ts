import { describe, expect, it } from "vitest";
import { canonicalizeUrl, urlHash } from "../src/crawl/canonical";

describe("canonicalizeUrl", () => {
  const table: Array<[string, string, string | null]> = [
    ["lowercases scheme and host", "HTTPS://Example.COM/Essays/A", "https://example.com/Essays/A"],
    ["drops default port", "https://example.com:443/a", "https://example.com/a"],
    ["keeps other ports", "http://example.com:8080/a", "http://example.com:8080/a"],
    ["drops fragment", "https://example.com/a#section-2", "https://example.com/a"],
    ["drops trailing slash", "https://example.com/a/b/", "https://example.com/a/b"],
    ["keeps the root slash", "https://example.com", "https://example.com/"],
    ["drops tracking params", "https://example.com/a?utm_source=x&id=7&fbclid=abc&UTM_Medium=m", "https://example.com/a?id=7"],
    ["sorts the query", "https://example.com/a?b=2&a=1&a=0", "https://example.com/a?a=0&a=1&b=2"],
    ["drops credentials", "https://user:pw@example.com/a", "https://example.com/a"],
    ["resolves dot segments", "https://example.com/a/./b/../c", "https://example.com/a/c"],
    ["normalizes escapes", "https://example.com/%7Euser/a%2fb/%c3%a9", "https://example.com/~user/a%2Fb/%C3%A9"],
    ["empty query mark", "https://example.com/a?", "https://example.com/a"],
    ["rejects ftp", "ftp://example.com/a", null],
    ["rejects javascript", "javascript:alert(1)", null],
    ["rejects garbage", "not a url", null],
  ];
  it.each(table)("%s", (_name, input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it("resolves relative references against a base", () => {
    expect(canonicalizeUrl("../b/?utm_campaign=z", "https://example.com/a/c/")).toBe("https://example.com/a/b");
  });

  it("is idempotent", () => {
    for (const [, , expected] of table) {
      if (expected) expect(canonicalizeUrl(expected)).toBe(expected);
    }
  });

  it("hashes the canonical form to 64 hex chars", () => {
    expect(urlHash("https://example.com/a")).toMatch(/^[0-9a-f]{64}$/);
    expect(urlHash("https://example.com/a")).toBe(urlHash("https://example.com/a"));
    expect(urlHash("https://example.com/a")).not.toBe(urlHash("https://example.com/b"));
  });
});
