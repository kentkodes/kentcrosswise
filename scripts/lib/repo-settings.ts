// The `main` ruleset (DESIGN §4.1, P1-17): expected definitions, comparison with what GitHub
// returns, and the REST calls to read or write it. Pure parts are unit-tested on fixtures.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * final:   DESIGN §4.1 (1 approval; ci/required + kcw/merge-rules). Needs the orchestrator App id,
 *          so it applies from P2-07 on.
 * interim: from the start of Phase 2 until P2-07: PRs required, ci/required, 0 approvals (the
 *          owner cannot approve their own PRs and the QA App does not exist yet).
 */
export type Profile = "final" | "interim";
export const PROFILES: readonly Profile[] = ["final", "interim"];

/** GitHub Actions' App id: the expected source of `ci/required`. */
export const GITHUB_ACTIONS_APP_ID = 15368;
export const RULESET_NAME = "main-protection";
const APP_ID_PLACEHOLDER = "${ORCHESTRATOR_APP_ID}";

export interface StatusCheck {
  context: string;
  integration_id?: number;
}

export interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface Ruleset {
  id?: number;
  name: string;
  target?: string;
  enforcement?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  /** GitHub omits this for callers who cannot see bypass actors. */
  bypass_actors?: unknown[];
  rules?: Rule[];
}

const settingsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "repo-settings");

export function expectedFile(profile: Profile): string {
  return path.join(settingsDir, profile === "final" ? "main-protection.json" : "main-protection.interim.json");
}

/**
 * Loads the expected ruleset. The final profile names the orchestrator App as the source of
 * kcw/merge-rules: with `orchestratorAppId` it is filled in; without it, the check is kept
 * without a source (compare mode only; `apply` refuses).
 */
export function loadExpected(profile: Profile, orchestratorAppId?: number): Ruleset {
  const raw = JSON.parse(readFileSync(expectedFile(profile), "utf8")) as Ruleset;
  return resolvePlaceholders(raw, orchestratorAppId);
}

export function resolvePlaceholders(ruleset: Ruleset, orchestratorAppId?: number): Ruleset {
  const copy = structuredClone(ruleset);
  for (const rule of copy.rules ?? []) {
    const checks = rule.parameters?.required_status_checks as (StatusCheck | { context: string; integration_id: string })[] | undefined;
    if (!checks) continue;
    rule.parameters!.required_status_checks = checks.map((c) => {
      if (c.integration_id !== APP_ID_PLACEHOLDER) return c;
      return orchestratorAppId === undefined ? { context: c.context } : { context: c.context, integration_id: orchestratorAppId };
    });
  }
  return copy;
}

/** Required checks without an expected source App (apply refuses these: any App could post them). */
export function checksWithoutSource(ruleset: Ruleset): string[] {
  return (ruleset.rules ?? [])
    .flatMap((r) => (r.parameters?.required_status_checks as StatusCheck[] | undefined) ?? [])
    .filter((c) => c.integration_id === undefined)
    .map((c) => c.context);
}

/** The body for POST/PUT /repos/{repo}/rulesets: only the fields GitHub accepts. */
export function requestBody(ruleset: Ruleset): Omit<Ruleset, "id"> {
  const { name, target, enforcement, conditions, bypass_actors, rules } = ruleset;
  return { name, target, enforcement, conditions, bypass_actors, rules };
}

/** Parses --profile (default final). */
export function profileArg(v: unknown): Profile {
  const p = typeof v === "string" ? v : "final";
  if (!(PROFILES as readonly string[]).includes(p)) throw new Error(`--profile must be one of ${PROFILES.join(", ")}`);
  return p as Profile;
}

export function appIdArg(v: unknown): number | undefined {
  const raw = typeof v === "string" && v !== "" ? v : process.env.KCW_ORCHESTRATOR_APP_ID;
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("orchestrator App id must be a positive integer");
  return Number(raw);
}

// ---------- comparison ----------

export interface Comparison {
  /** Differences that make the repo settings wrong. Empty = matches. */
  drift: string[];
  /** Things that could not be checked. */
  warnings: string[];
}

function normalizeRef(ref: string): string {
  return ref === "refs/heads/main" ? "~DEFAULT_BRANCH" : ref;
}

function sameSet(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = [...new Set(a ?? [])].sort();
  const y = [...new Set(b ?? [])].sort();
  return JSON.stringify(x) === JSON.stringify(y);
}

function checkKey(c: StatusCheck): string {
  return c.integration_id === undefined ? c.context : `${c.context} (app ${c.integration_id})`;
}

function compareStatusChecks(expected: StatusCheck[], actual: StatusCheck[] | undefined, drift: string[], warnings: string[]): void {
  const act = actual ?? [];
  for (const e of expected) {
    const match = act.find((a) => a.context === e.context);
    if (!match) {
      drift.push(`required status check "${e.context}" is missing`);
    } else if (e.integration_id === undefined) {
      warnings.push(`source of "${e.context}" not checked (orchestrator App id unknown)`);
    } else if (match.integration_id !== e.integration_id) {
      drift.push(`required status check "${e.context}": expected source app ${e.integration_id}, found ${match.integration_id ?? "any source"}`);
    }
  }
  for (const a of act) {
    if (!expected.some((e) => e.context === a.context)) drift.push(`unexpected required status check ${checkKey(a)}`);
  }
}

export function compareRuleset(expected: Ruleset, actual: Ruleset | undefined): Comparison {
  const drift: string[] = [];
  const warnings: string[] = [];
  if (!actual) return { drift: [`ruleset "${expected.name}" does not exist`], warnings };

  for (const key of ["name", "target", "enforcement"] as const) {
    if (expected[key] !== actual[key]) drift.push(`${key}: expected ${JSON.stringify(expected[key])}, found ${JSON.stringify(actual[key])}`);
  }

  const eRef = expected.conditions?.ref_name;
  const aRef = actual.conditions?.ref_name;
  if (!sameSet(eRef?.include?.map(normalizeRef), aRef?.include?.map(normalizeRef))) {
    drift.push(`target branches: expected ${JSON.stringify(eRef?.include ?? [])}, found ${JSON.stringify(aRef?.include ?? [])}`);
  }
  if (!sameSet(eRef?.exclude, aRef?.exclude)) {
    drift.push(`excluded branches: expected ${JSON.stringify(eRef?.exclude ?? [])}, found ${JSON.stringify(aRef?.exclude ?? [])}`);
  }

  if (actual.bypass_actors === undefined) {
    warnings.push("bypass list not visible with this token (needs admin read); not checked");
  } else if (actual.bypass_actors.length !== (expected.bypass_actors ?? []).length) {
    drift.push(`bypass list must be empty, found ${actual.bypass_actors.length} actor(s)`);
  }

  const eRules = new Map((expected.rules ?? []).map((r) => [r.type, r]));
  const aRules = new Map((actual.rules ?? []).map((r) => [r.type, r]));
  for (const type of eRules.keys()) if (!aRules.has(type)) drift.push(`rule "${type}" is missing`);
  for (const type of aRules.keys()) if (!eRules.has(type)) drift.push(`unexpected rule "${type}"`);

  for (const [type, e] of eRules) {
    const a = aRules.get(type);
    if (!a || !e.parameters) continue;
    for (const [key, ev] of Object.entries(e.parameters)) {
      const av = a.parameters?.[key];
      if (key === "required_status_checks") {
        compareStatusChecks(ev as StatusCheck[], av as StatusCheck[] | undefined, drift, warnings);
      } else if (Array.isArray(ev)) {
        if (!Array.isArray(av) || !sameSet(ev.map(String), av.map(String))) {
          drift.push(`${type}.${key}: expected ${JSON.stringify(ev)}, found ${JSON.stringify(av)}`);
        }
      } else if (ev !== av) {
        drift.push(`${type}.${key}: expected ${JSON.stringify(ev)}, found ${JSON.stringify(av)}`);
      }
    }
  }
  return { drift, warnings };
}

// ---------- GitHub REST ----------

export interface GitHubOptions {
  repo: string;
  token?: string;
  fetch?: typeof fetch;
  apiUrl?: string;
}

async function gh(opts: GitHubOptions, method: string, url: string, body?: unknown): Promise<Response> {
  const f = opts.fetch ?? fetch;
  return f(`${opts.apiUrl ?? "https://api.github.com"}${url}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/** Reads the named branch ruleset of the repo (not inherited ones), or undefined if none. */
export async function fetchRuleset(opts: GitHubOptions, name = RULESET_NAME): Promise<Ruleset | undefined> {
  const list = await gh(opts, "GET", `/repos/${opts.repo}/rulesets?per_page=100&includes_parents=false`);
  if (!list.ok) throw new Error(`GitHub API returned ${list.status} listing rulesets of ${opts.repo}`);
  const found = ((await list.json()) as { id: number; name: string }[]).find((r) => r.name === name);
  if (!found) return undefined;
  const one = await gh(opts, "GET", `/repos/${opts.repo}/rulesets/${found.id}`);
  if (!one.ok) throw new Error(`GitHub API returned ${one.status} reading ruleset ${found.id}`);
  return (await one.json()) as Ruleset;
}

/** Creates the ruleset, or replaces the existing one with the same name. */
export async function applyRuleset(opts: GitHubOptions, ruleset: Ruleset): Promise<{ action: "created" | "updated"; id: number }> {
  const existing = await fetchRuleset(opts, ruleset.name);
  const body = requestBody(ruleset);
  const res = existing?.id
    ? await gh(opts, "PUT", `/repos/${opts.repo}/rulesets/${existing.id}`, body)
    : await gh(opts, "POST", `/repos/${opts.repo}/rulesets`, body);
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${existing ? "updating" : "creating"} the ruleset`);
  const saved = (await res.json()) as { id: number };
  return { action: existing ? "updated" : "created", id: saved.id };
}
