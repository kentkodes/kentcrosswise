import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every dependency declared in the workspace must be on agents/merge-rules/approved-deps.json.
// (The full critical-change detector is P2-04; this keeps the seed list honest meanwhile.)
const repo = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(`${repo}${p}`, "utf8")) as Record<string, unknown>;

const PACKAGE_FILES = [
  "package.json",
  "apps/web/package.json",
  "scripts/package.json",
  "agents/merge-rules/package.json",
  "agents/report/package.json",
  ...["core", "db", "secrets", "essays", "demo-data", "xray"].map((p) => `packages/${p}/package.json`),
];

function allowed(name: string, list: readonly string[]): boolean {
  return list.some((entry) => (entry.endsWith("/*") ? name.startsWith(entry.slice(0, -1)) : entry === name));
}

describe("approved-deps.json", () => {
  const list = JSON.parse(readFileSync(`${repo}agents/merge-rules/approved-deps.json`, "utf8")) as string[];

  it("is a sorted array of unique strings", () => {
    expect(list.every((x) => typeof x === "string")).toBe(true);
    expect(new Set(list).size).toBe(list.length);
    expect([...list].sort()).toEqual(list);
  });

  it("covers every dependency in the workspace", () => {
    const missing: string[] = [];
    for (const file of PACKAGE_FILES) {
      const pkg = read(file);
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        for (const [name, version] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
          if (version.startsWith("workspace:")) continue;
          if (!allowed(name, list)) missing.push(`${file}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
