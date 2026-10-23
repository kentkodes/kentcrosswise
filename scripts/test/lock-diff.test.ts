import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeLockDiff, depIdentity, lockDiffMarkdown, LockfileFormatError, parseLockImporters } from "../lib/lock-diff";

const repoLock = readFileSync(fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url)), "utf8");

/** A synthetic lockfile in pnpm 12's layout (env document, then the main one). */
function lock(importers: string): string {
  return [
    "---",
    "lockfileVersion: '9.0'",
    "",
    "importers:",
    "",
    "  .:",
    "    configDependencies: {}",
    "    packageManagerDependencies:",
    "      pnpm:",
    "        specifier: 12.14.0",
    "        version: 12.14.0",
    "",
    "packages:",
    "",
    "  pnpm@12.14.0:",
    "    resolution: {integrity: sha512-AAAA}",
    "",
    "---",
    "lockfileVersion: '9.0'",
    "",
    "settings:",
    "  autoInstallPeers: true",
    "",
    "importers:",
    "",
    importers,
    "packages:",
    "",
    "  zod@4.6.7:",
    "    resolution: {integrity: sha512-BBBB}",
    "",
  ].join("\n");
}

const BASE = lock(`  .:
    devDependencies:
      vitest:
        specifier: ^5.0.5
        version: 5.0.5(@types/node@24.19.2)

  agents/merge-rules: {}

  agents/report:
    dependencies:
      '@aws-sdk/client-sqs':
        specifier: ^3.1154.0
        version: 3.1154.0
      '@kcw/core':
        specifier: workspace:*
        version: link:../../packages/core
    devDependencies:
      zod:
        specifier: ^4.6.0
        version: 4.6.7
`);

describe("parseLockImporters", () => {
  it("reads direct dependencies per importer and ignores packageManagerDependencies", () => {
    const m = parseLockImporters(BASE);
    expect([...m.keys()]).toEqual([".", "agents/merge-rules", "agents/report"]);
    expect(m.get(".")).toEqual([{ name: "vitest", specifier: "^5.0.5", version: "5.0.5(@types/node@24.19.2)" }]);
    expect(m.get("agents/merge-rules")).toEqual([]);
    expect(m.get("agents/report")!.map((d) => d.name)).toEqual(["@aws-sdk/client-sqs", "@kcw/core", "zod"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseLockImporters(BASE.replace(/\n/g, "\r\n"))).toEqual(parseLockImporters(BASE));
  });

  it("reads the repository's own lockfile", () => {
    const m = parseLockImporters(repoLock);
    expect(m.has(".")).toBe(true);
    expect(m.has("scripts")).toBe(true);
    expect(m.get(".")!.map((d) => d.name)).toContain("vitest");
    expect(m.get("scripts")!.map((d) => d.name)).toContain("@kcw/core");
  });

  it("fails closed on layouts it does not know", () => {
    expect(() => parseLockImporters("lockfileVersion: '9.0'\n")).toThrow(LockfileFormatError);
    expect(() => parseLockImporters(lock("  .:\n    dependencies:\n      zod:\n        specifier: ^4\n"))).toThrow(/without specifier and version/);
    expect(() => parseLockImporters(lock("  .:\n    dependencies:\n      zod: 4.6.7\n"))).toThrow(/unexpected dependency entry/);
    expect(() => parseLockImporters(lock("  .:\n    dependencies: {zod: 4}\n"))).toThrow(/unexpected inline/);
    expect(() =>
      parseLockImporters(lock("  .:\n    dependencies:\n      zod:\n        specifier: ^4\n        version: 4.6.7\n        resolution: x\n")),
    ).toThrow(/unexpected dependency property/);
  });
});

describe("depIdentity", () => {
  const d = (name: string, specifier: string, version = "1.0.0") => depIdentity({ name, specifier, version });
  it("is the package name for registry dependencies", () => {
    expect(d("zod", "^4.6.0")).toBe("zod");
    expect(d("@aws-sdk/client-sqs", "^3.1154.0")).toBe("@aws-sdk/client-sqs");
    expect(d("next", "latest")).toBe("next");
  });
  it("skips workspace packages", () => {
    expect(d("@kcw/core", "workspace:*", "link:../../packages/core")).toBeUndefined();
  });
  it("is the installed package for npm aliases", () => {
    expect(d("zod", "npm:evil-pkg@^1.0.0", "evil-pkg@1.0.0")).toBe("evil-pkg");
    expect(d("zod", "npm:@evil/pkg@1", "@evil/pkg@1.0.0")).toBe("@evil/pkg");
  });
  it("never matches an allowlist entry for other sources", () => {
    expect(d("zod", "github:someone/zod", "https://codeload.github.com/someone/zod/tar.gz/abc")).toBe("zod (github:someone/zod)");
    expect(d("zod", "someone/zod")).toBe("zod (someone/zod)");
    expect(d("zod", "https://example.com/zod.tgz", "https://example.com/zod.tgz")).toBe("zod (https://example.com/zod.tgz)");
    expect(d("zod", "file:../zod", "file:../zod")).toBe("zod (file:../zod)");
    expect(d("zod", "link:../zod", "link:../zod")).toBe("zod (link:../zod)");
    expect(d("zod", "^4", "link:../zod")).toBe("zod (^4)");
  });
});

describe("computeLockDiff", () => {
  it("is empty when nothing changed, and lists the base's direct dependencies", () => {
    expect(computeLockDiff(BASE, BASE)).toEqual({
      added: [],
      existing: ["@aws-sdk/client-sqs", "vitest", "zod"],
    });
    const own = computeLockDiff(repoLock, repoLock);
    expect(own.added).toEqual([]);
    expect(own.existing).toContain("pg");
    expect(own.existing.some((n) => n.startsWith("@kcw/"))).toBe(false);
  });

  it("reports added dependencies per importer, including new importers", () => {
    const head = BASE.replace(
      "  agents/merge-rules: {}\n",
      `  agents/merge-rules: {}

  agents/new-pkg:
    dependencies:
      '@aws-sdk/client-sqs':
        specifier: ^3.1154.0
        version: 3.1154.0
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0
`,
    ).replace(
      "  .:\n    devDependencies:\n",
      "  .:\n    dependencies:\n      kysely:\n        specifier: ^0.29.0\n        version: 0.29.0\n    devDependencies:\n",
    );
    expect(computeLockDiff(BASE, head).added).toEqual([
      { importer: ".", name: "kysely" },
      { importer: "agents/new-pkg", name: "@aws-sdk/client-sqs" },
      { importer: "agents/new-pkg", name: "left-pad" },
    ]);
  });

  it("ignores version bumps, removals, moves between fields and new workspace links", () => {
    const head = BASE.replace("specifier: ^4.6.0\n        version: 4.6.7", "specifier: ^4.7.0\n        version: 4.7.0")
      .replace("    devDependencies:\n      zod:", "    optionalDependencies:\n      zod:")
      .replace(/ {6}'@aws-sdk\/client-sqs':\n {8}specifier: \^3\.1154\.0\n {8}version: 3\.1154\.0\n/, "")
      .replace("  agents/merge-rules: {}", "  agents/merge-rules:\n    dependencies:\n      '@kcw/core':\n        specifier: workspace:*\n        version: link:../../packages/core");
    expect(computeLockDiff(BASE, head).added).toEqual([]);
  });

  it("reports an alias switched to another package under an existing name", () => {
    const head = BASE.replace("specifier: ^4.6.0\n        version: 4.6.7", "specifier: npm:evil-pkg@^1.0.0\n        version: evil-pkg@1.0.0");
    expect(computeLockDiff(BASE, head).added).toEqual([{ importer: "agents/report", name: "evil-pkg" }]);
  });
});

describe("lockDiffMarkdown", () => {
  it("lists names only", () => {
    expect(lockDiffMarkdown({ added: [], existing: ["zod"] })).toContain("None.");
    expect(lockDiffMarkdown({ added: [{ importer: "agents/x", name: "left-pad" }], existing: [] })).toContain("- `left-pad` in `agents/x`");
  });
});
