// No cache poisoning path (AR1 slice 2): a job that runs candidate code in the default-branch context can
// save entries under the default-branch cache scope, and every main-context job that restores them would
// install the poisoned dependencies. So only credential-free jobs of a workflow triggered solely by
// pull_request (their cache entries are PR-scoped) may enable the pnpm cache, and nothing else caches.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r/g, "").replace(/^ *#.*\n/gm, "");
const workflows = readdirSync(path.join(root, ".github/workflows")).filter((f) => f.endsWith(".yml"));
const actions = readdirSync(path.join(root, ".github/actions")).map((d) => `.github/actions/${d}/action.yml`);

function jobs(yml: string): Record<string, string> {
  const section = yml.slice(yml.indexOf("\njobs:\n") + 7);
  const out: Record<string, string> = {};
  const parts = section.split(/^ {2}([a-z0-9-]+):\n/gm);
  for (let i = 1; i < parts.length; i += 2) out[parts[i]!] = parts[i + 1]!;
  return out;
}

/** The trigger names under the top-level `on:`. */
function triggers(yml: string): string[] {
  const m = /^on:\n((?: {2}.*\n|\n)*)/m.exec(yml);
  return [...(m?.[1] ?? "").matchAll(/^ {2}([a-z_]+):/gm)].map((x) => x[1]!);
}

describe("caches", () => {
  it("the setup action caches only when asked, and defaults to no cache", () => {
    const setup = read(".github/actions/setup/action.yml");
    expect(setup).toMatch(/ {2}cache:\n(?: {4}.*\n)*? {4}default: "false"/);
    expect(setup).toContain("cache: ${{ inputs.cache }}");
    expect(setup).toContain("package-manager-cache: false");
    expect(setup).not.toMatch(/setup-terraform[\s\S]*cache/);
  });

  it("only credential-free pull_request-only jobs set cache: true on the setup action", () => {
    const cached: string[] = [];
    for (const file of workflows) {
      const yml = read(`.github/workflows/${file}`);
      for (const [name, body] of Object.entries(jobs(yml))) {
        if (!/uses: \.\/\.github\/actions\/setup\n\s+with:\n(?:\s+\S.*\n)*?\s+cache: "?true"?\n/.test(body)) continue;
        cached.push(`${file}:${name}`);
        expect(triggers(yml), `${file} must be triggered only by pull_request`).toEqual(["pull_request"]);
        expect(body, `${file}:${name} must not hold id-token`).not.toContain("id-token");
        expect(body, `${file}:${name} must not use an environment`).not.toMatch(/^ {4}environment:/m);
        expect(body, `${file}:${name} must not use secrets`).not.toContain("secrets.");
      }
    }
    expect(cached.sort()).toEqual(["ci.yml:candidate-build", "ci.yml:checks"]);
  });

  it("no workflow or action uses actions/cache or another caching setting", () => {
    for (const file of [...workflows.map((f) => `.github/workflows/${f}`), ...actions]) {
      const yml = read(file);
      expect(yml, file).not.toMatch(/actions\/(cache|cache\/restore|cache\/save)@/);
      expect(yml, file).not.toMatch(/cache-dependency-path|cache-to|cache-from/);
      if (file !== ".github/actions/setup/action.yml") {
        // `cache: false` is fine; `cache: true|npm|pnpm|yarn` is not (setup-node, pnpm/action-setup).
        expect(yml, file).not.toMatch(/^\s+cache: (true|npm|pnpm|yarn)\s*$/m);
        expect(yml, file).not.toMatch(/package-manager-cache: true/);
      }
    }
  });
});
