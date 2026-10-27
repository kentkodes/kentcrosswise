import { createHash } from "node:crypto";

/** RFC 9309 asks crawlers to parse at least 500 KiB; anything after that is ignored. */
const MAX_ROBOTS_BYTES = 500 * 1024;

export interface RobotsRule {
  allow: boolean;
  /** Path pattern as written (may contain `*` and a trailing `$`). */
  pattern: string;
}

export interface RobotsGroup {
  /** Lowercased product tokens (`*` for the default group). */
  agents: string[];
  rules: RobotsRule[];
  /** Crawl-delay in milliseconds (non-standard, but honored), or null. */
  crawlDelayMs: number | null;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
}

/** The product token of a User-Agent string: `KentcrosswiseBot/1.0 (+x)` -> `kentcrosswisebot`. */
export function productToken(userAgent: string): string {
  return (/^[A-Za-z0-9_-]+/.exec(userAgent.trim())?.[0] ?? "").toLowerCase();
}

/** Parses robots.txt per RFC 9309: consecutive User-agent lines open one group; unknown lines are ignored. */
export function parseRobots(text: string): ParsedRobots {
  const bom = String.fromCharCode(0xfeff);
  let body = text.startsWith(bom) ? text.slice(1) : text;
  if (Buffer.byteLength(body) > MAX_ROBOTS_BYTES) body = Buffer.from(body).subarray(0, MAX_ROBOTS_BYTES).toString("utf8");
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let inAgents = false; // the last significant line was a User-agent line
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === "user-agent") {
      if (!current || !inAgents) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgents = true;
      continue;
    }
    if (field === "allow" || field === "disallow") {
      inAgents = false;
      if (!current) continue;
      // An empty Disallow allows everything; an empty Allow changes nothing. Neither needs a rule.
      if (value) current.rules.push({ allow: field === "allow", pattern: value });
    } else if (field === "crawl-delay") {
      inAgents = false;
      const secs = Number(value);
      if (current && Number.isFinite(secs) && secs >= 0) current.crawlDelayMs = Math.round(secs * 1000);
    }
  }
  return { groups };
}

/** Uppercases escapes and decodes unreserved ones (same rule as the URL canonicalizer). */
function normalizePath(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, h: string) => {
    const ch = String.fromCharCode(parseInt(h, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${h.toUpperCase()}`;
  });
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const body = normalizePath(core)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** The group(s) for our product token, merged; else the `*` groups merged; else none. */
function groupsFor(parsed: ParsedRobots, token: string): RobotsGroup[] {
  const own = parsed.groups.filter((g) => g.agents.includes(token));
  return own.length ? own : parsed.groups.filter((g) => g.agents.includes("*"));
}

/** Whether `pathAndQuery` (e.g. `/ebooks/12?x=1`) may be fetched. Longest matching pattern wins; Allow wins ties. */
export function robotsAllows(parsed: ParsedRobots, userAgent: string, pathAndQuery: string): boolean {
  const path = normalizePath(pathAndQuery);
  if (path === "/robots.txt") return true;
  let best: { len: number; allow: boolean } | null = null;
  for (const g of groupsFor(parsed, productToken(userAgent))) {
    for (const r of g.rules) {
      if (!patternToRegExp(r.pattern).test(path)) continue;
      const len = r.pattern.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
    }
  }
  return best ? best.allow : true;
}

/** Largest Crawl-delay among the groups that apply to us, in ms (0 if none). */
export function robotsCrawlDelayMs(parsed: ParsedRobots, userAgent: string): number {
  return Math.max(0, ...groupsFor(parsed, productToken(userAgent)).map((g) => g.crawlDelayMs ?? 0));
}

/** How a robots.txt fetch ended, before interpretation. */
export type RobotsFetch =
  | { kind: "response"; status: number; body: string }
  | { kind: "error"; reason: string };

export type RobotsStatus = "ok" | "not_found" | "forbidden" | "unreachable";

export interface RobotsPolicy {
  status: RobotsStatus;
  parsed: ParsedRobots;
  /** sha256 of the body, null when there was none. */
  sha256: string | null;
  fetchedAt: Date;
  /** Transient failures are not cached beyond the run: the next run fetches again. */
  cacheable: boolean;
}

const DISALLOW_ALL: ParsedRobots = {
  groups: [{ agents: ["*"], rules: [{ allow: false, pattern: "/" }], crawlDelayMs: null }],
};

/**
 * Design section 4: 200 parses; 404 (and other unavailable 4xx) allows all; 401/403 disallows all;
 * 429, 5xx, redirects we could not follow, timeouts and network errors disallow all for this run
 * (fail closed, fetched again next run).
 */
export function interpretRobots(result: RobotsFetch, now: Date): RobotsPolicy {
  const closed = (status: RobotsStatus, cacheable: boolean): RobotsPolicy => ({
    status, parsed: DISALLOW_ALL, sha256: null, fetchedAt: now, cacheable,
  });
  if (result.kind === "error") return closed("unreachable", false);
  const { status, body } = result;
  if (status >= 200 && status < 300) {
    return {
      status: "ok", parsed: parseRobots(body), sha256: createHash("sha256").update(body).digest("hex"),
      fetchedAt: now, cacheable: true,
    };
  }
  if (status === 401 || status === 403) return closed("forbidden", true);
  if (status === 429 || status >= 500 || status < 200 || (status >= 300 && status < 400)) return closed("unreachable", false);
  return { status: "not_found", parsed: { groups: [] }, sha256: null, fetchedAt: now, cacheable: true };
}

export const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-origin cache of robots policies, 24 h. A fail-closed result from a transient failure is kept
 * for the rest of the run only: `startRun` drops it so the next run fetches again.
 */
export class RobotsCache {
  private readonly entries = new Map<string, RobotsPolicy>();

  constructor(private readonly ttlMs: number = ROBOTS_TTL_MS) {}

  startRun(): void {
    for (const [origin, policy] of this.entries) if (!policy.cacheable) this.entries.delete(origin);
  }

  get(origin: string, now: Date): RobotsPolicy | null {
    const hit = this.entries.get(origin);
    if (!hit) return null;
    if (hit.cacheable && now.getTime() - hit.fetchedAt.getTime() >= this.ttlMs) {
      this.entries.delete(origin);
      return null;
    }
    return hit;
  }

  /** Cached policy, or `load()` (the network fetch, through the polite client) interpreted and stored. */
  async getOrLoad(origin: string, now: Date, load: () => Promise<RobotsFetch>): Promise<RobotsPolicy> {
    const hit = this.get(origin, now);
    if (hit) return hit;
    const policy = interpretRobots(await load(), now);
    this.entries.set(origin, policy);
    return policy;
  }
}
