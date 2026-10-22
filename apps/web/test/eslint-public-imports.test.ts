import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Lints fixture files as if they lived at real paths, using the repo's own eslint.config.js.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

async function restrictedImports(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repo });
  const [result] = await eslint.lintText(code, { filePath: `${repo}${filePath}` });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

describe("D10: (public) import restriction", () => {
  const bad = fixture("public-imports-db.tsx");
  const ok = fixture("public-imports-ok.tsx");

  it("blocks @kcw/db, @kcw/secrets and pg in a (public) page", async () => {
    const msgs = await restrictedImports(bad, "apps/web/src/app/(public)/demo/page.tsx");
    expect(msgs).toHaveLength(3);
    expect(msgs.join("\n")).toMatch(/'@kcw\/db'/);
    expect(msgs.join("\n")).toMatch(/'@kcw\/secrets'/);
    expect(msgs.join("\n")).toMatch(/'pg'/);
  });

  it("blocks subpath and owner imports too", async () => {
    const code = [
      'import { seedDemo } from "@kcw/db/seeds";',
      'import Hub from "../(owner)/hub/page";',
      'import { x } from "@/server/db";',
      "export const all = [seedDemo, Hub, x];",
    ].join("\n");
    const msgs = await restrictedImports(code, "apps/web/src/app/(public)/page.tsx");
    expect(msgs).toHaveLength(3);
  });

  it("allows @kcw/demo-data and @kcw/xray in (public)", async () => {
    expect(await restrictedImports(ok, "apps/web/src/app/(public)/demo/page.tsx")).toEqual([]);
  });

  it("does not apply outside (public)", async () => {
    expect(await restrictedImports(bad, "apps/web/src/app/(owner)/hub/page.tsx")).toEqual([]);
  });

  it("the real public pages pass", async () => {
    const eslint = new ESLint({ cwd: repo });
    const results = await eslint.lintFiles(["apps/web/src/app/(public)/**/*.tsx"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.flatMap((r) => r.messages)).toEqual([]);
  });
});
