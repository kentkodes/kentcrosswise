// HTTP smoke checks for a deployed stack (deploy.yml after the prod apply; ci.yml waits for a new
// preview with it). Retries cover CloudFront propagation right after an apply. With a build id,
// every page check also proves the response is from this build (stale edge cache otherwise passes).

export interface SmokeExpectation {
  path: string;
  /** "ok": status 200 (and the build id, when checked). "redirect": a 3xx whose Location matches `location`. */
  expect: "ok" | "redirect";
  location?: RegExp;
}

/** Public pages, plus `/hub`, which sends a logged-out visitor to the sign-in page. */
export const DEFAULT_CHECKS: SmokeExpectation[] = [
  { path: "/", expect: "ok" },
  { path: "/demo", expect: "ok" },
  { path: "/office", expect: "ok" },
  { path: "/bot", expect: "ok" },
  { path: "/hub", expect: "redirect", location: /\/api\/auth\/signin/ },
];

export type FetchLike = (url: string, init: { redirect: "manual"; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface SmokeOptions {
  baseUrl: string;
  checks?: SmokeExpectation[];
  /** Next build id of the build under test (apps/web/.open-next/kcw-build.json). */
  buildId?: string;
  attempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--url must be an absolute https:// URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("--url must use https (http only for localhost)");
  }
  return url.origin;
}

/** Reads the build id from `--build-file` JSON. Throws before any request when it is unusable. */
export function parseBuildFile(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("--build-file must contain JSON");
  }
  const id = (parsed as { build_id?: unknown } | null)?.build_id;
  if (typeof id !== "string" || id === "") throw new Error("--build-file has no build_id string");
  return id;
}

/**
 * App Router HTML carries the build id in its flight data as `"b":"<id>"`; inside a script string
 * the quotes are escaped. Either form proves the page came from this build.
 */
export function hasBuildId(body: string, buildId: string): boolean {
  return body.includes(`"b":"${buildId}"`) || body.includes(`\\"b\\":\\"${buildId}\\"`);
}

/** One check against one response. Returns a problem description, or undefined when it passes. */
export function judge(check: SmokeExpectation, status: number, location: string | null): string | undefined {
  if (check.expect === "ok") return status === 200 ? undefined : `${check.path}: expected 200, got ${status}`;
  if (status < 300 || status > 399) return `${check.path}: expected a redirect, got ${status}`;
  if (check.location && !(location !== null && check.location.test(location))) {
    return `${check.path}: redirect to ${location ?? "(no Location)"} does not match ${check.location}`;
  }
  return undefined;
}

/** Runs every check, retrying the whole set until it passes or attempts run out. Throws on failure. */
export async function runSmoke(opts: SmokeOptions): Promise<void> {
  const base = normalizeBaseUrl(opts.baseUrl);
  const checks = opts.checks ?? DEFAULT_CHECKS;
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 15_000;
  const f = opts.fetch ?? (fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.log(line));
  const buildId = opts.buildId;

  let problems: string[] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    problems = [];
    for (const check of checks) {
      try {
        const res = await f(`${base}${check.path}`, { redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
        let p = judge(check, res.status, res.headers.get("location"));
        if (!p && buildId !== undefined && check.expect === "ok" && !hasBuildId(await res.text(), buildId)) {
          p = `${check.path}: build ${buildId} not found (stale cache?)`;
        }
        if (p) problems.push(p);
      } catch (err) {
        problems.push(`${check.path}: request failed (${err instanceof Error ? err.name : "error"})`);
      }
    }
    if (problems.length === 0) {
      const build = buildId === undefined ? "" : `, build ${buildId}`;
      log(`smoke-check: ${checks.map((c) => c.path).join(", ")} OK on ${base}${build} (attempt ${attempt})`);
      return;
    }
    log(`smoke-check: attempt ${attempt}/${attempts}: ${problems.join("; ")}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(`smoke check failed on ${base}: ${problems.join("; ")}`);
}
