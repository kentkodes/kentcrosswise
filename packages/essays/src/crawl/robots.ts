import { createHash } from "node:crypto";

/**
 * RFC 9309 asks crawlers to parse at least 500 KiB. A larger file is not truncated (a cut line or a
 * dropped later rule could allow what the full file disallows): it fails closed for the run instead.
 */
export const MAX_ROBOTS_BYTES = 500 * 1024;

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

/**
 * Parses robots.txt per RFC 9309: consecutive User-agent lines open one group; unknown lines are ignored.
 * The whole text is parsed; `interpretRobots` refuses a body over MAX_ROBOTS_BYTES before it gets here.
 */
export function parseRobots(text: string): ParsedRobots {
  const bom = String.fromCharCode(0xfeff);
  const body = text.startsWith(bom) ? text.slice(1) : text;
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

/**
 * Whether `path` matches a robots pattern from its start: `*` is any run of characters and a trailing
 * `$` anchors the end; every other character (a `$` elsewhere included) is literal. No regex and no
 * backtracking: each literal piece between wildcards takes its leftmost position after the previous
 * one, which never loses a match because an earlier placement only leaves later pieces more room.
 * With the anchor, the last piece must end the path after everything before it.
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const pieces = normalizePath(anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = pieces[0]!;
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  for (let i = 1; i < pieces.length - 1; i++) {
    const at = path.indexOf(pieces[i]!, pos);
    if (at < 0) return false;
    pos = at + pieces[i]!.length;
  }
  const last = pieces[pieces.length - 1]!;
  return anchored ? path.length - last.length >= pos && path.endsWith(last) : path.includes(last, pos);
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
      if (!robotsPatternMatches(r.pattern, path)) continue;
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
 * 429, 5xx, redirects we could not follow, timeouts, network errors and a body over MAX_ROBOTS_BYTES
 * disallow all for this run (fail closed, fetched again next run). Design decision 8.
 */
export function interpretRobots(result: RobotsFetch, now: Date): RobotsPolicy {
  const closed = (status: RobotsStatus, cacheable: boolean): RobotsPolicy => ({
    status, parsed: DISALLOW_ALL, sha256: null, fetchedAt: now, cacheable,
  });
  if (result.kind === "error") return closed("unreachable", false);
  const { status, body } = result;
  if (status >= 200 && status < 300) {
    if (Buffer.byteLength(body, "utf8") > MAX_ROBOTS_BYTES) return closed("unreachable", false);
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
export interface RobotsSnapshot { result: RobotsFetch; fetchedAt: string }
export interface RobotsStore {
  get(origin: string): Promise<RobotsSnapshot | null>;
  put(origin: string, snapshot: RobotsSnapshot): Promise<void>;
}

/**
 * Per-origin cache of robots policies, 24 h. A fail-closed result from a transient failure is kept
 * for the rest of the run only: `startRun` drops it so the next run fetches again.
 */
export class RobotsCache {
  private readonly entries = new Map<string, RobotsPolicy>();

  constructor(private readonly ttlMs: number = ROBOTS_TTL_MS, private readonly store?: RobotsStore) {}

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
    const saved = await this.store?.get(origin);
    if (saved) {
      const at = new Date(saved.fetchedAt);
      const age = now.getTime() - at.getTime();
      const restored = interpretRobots(saved.result, at);
      if (restored.cacheable && age >= 0 && age < this.ttlMs) {
        this.entries.set(origin, restored);
        return restored;
      }
    }
    const result = await load();
    const policy = interpretRobots(result, now);
    await this.store?.put(origin, { result, fetchedAt: now.toISOString() });
    this.entries.set(origin, policy);
    return policy;
  }
}
