import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hoistPnpm, materializeSymlinks, prunePnpm } from "../lib/materialize";

const root = mkdtempSync(path.join(tmpdir(), "kcw-materialize-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function file(rel: string, body = "x"): void {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
}

// Relative directory link, like pnpm's (junctions on Windows need no privilege but store absolute paths).
function link(rel: string, targetRel: string, base: string): void {
  const at = path.join(base, rel);
  mkdirSync(path.dirname(at), { recursive: true });
  const target = path.join(base, targetRel);
  if (process.platform === "win32") symlinkSync(target, at, "junction");
  else symlinkSync(path.relative(path.dirname(at), target), at, "dir");
}

describe("materializeSymlinks + hoistPnpm (pnpm-shaped OpenNext bundle)", () => {
  const bundle = path.join(root, "bundle");
  file("bundle/node_modules/.pnpm/next@1/node_modules/next/package.json", '{"name":"next"}');
  file("bundle/node_modules/.pnpm/@swc+helpers@1/node_modules/@swc/helpers/index.js", "helpers");
  link("node_modules/.pnpm/next@1/node_modules/@swc/helpers", "node_modules/.pnpm/@swc+helpers@1/node_modules/@swc/helpers", bundle);
  link("node_modules/.pnpm/node_modules/@swc/helpers", "node_modules/.pnpm/@swc+helpers@1/node_modules/@swc/helpers", bundle);
  link("node_modules/.pnpm/node_modules/next", "node_modules/.pnpm/next@1/node_modules/next", bundle);
  link("apps/web/node_modules/next", "node_modules/.pnpm/next@1/node_modules/next", bundle);
  file("bundle/node_modules/react/index.js", "root react wins");
  file("bundle/node_modules/.pnpm/react@1/node_modules/react/index.js", "pnpm react");
  link("node_modules/.pnpm/node_modules/react", "node_modules/.pnpm/react@1/node_modules/react", bundle);

  it("replaces every link with a real copy and hoists pnpm's hidden dir", () => {
    expect(materializeSymlinks(bundle)).toBe(5);
    const next = path.join(bundle, "apps/web/node_modules/next");
    expect(lstatSync(next).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(next, "package.json"), "utf8")).toContain("next");

    expect(hoistPnpm(bundle)).toEqual(["@swc/helpers", "next"]);
    expect(readFileSync(path.join(bundle, "node_modules/@swc/helpers/index.js"), "utf8")).toBe("helpers");
    expect(readFileSync(path.join(bundle, "node_modules/react/index.js"), "utf8")).toBe("root react wins");
    expect(materializeSymlinks(bundle)).toBe(0);
  });

  it("keeps node_modules/.pnpm when a nested version differs from the hoisted one", () => {
    file("bundle/node_modules/react/package.json", JSON.stringify({ version: "2.0.0" }));
    file("bundle/node_modules/.pnpm/react@1/node_modules/react/package.json", JSON.stringify({ version: "1.0.0" }));
    const res = prunePnpm(bundle);
    expect(res.pruned).toBe(false);
    expect(res.conflicts).toEqual(["react 1.0.0 vs hoisted 2.0.0"]);
  });

  it("removes node_modules/.pnpm when everything is hoisted", () => {
    file("bundle/node_modules/.pnpm/react@1/node_modules/react/package.json", JSON.stringify({ version: "2.0.0" }));
    expect(prunePnpm(bundle)).toEqual({ pruned: true, conflicts: [] });
    expect(existsSync(path.join(bundle, "node_modules/.pnpm"))).toBe(false);
    expect(existsSync(path.join(bundle, "node_modules/@swc/helpers/index.js"))).toBe(true);
  });

  it("refuses links that leave the bundle", () => {
    const outside = path.join(root, "outside");
    file("outside/pkg/index.js");
    const b2 = path.join(root, "bundle2");
    mkdirSync(path.join(b2, "node_modules"), { recursive: true });
    symlinkSync(path.join(outside, "pkg"), path.join(b2, "node_modules", "pkg"), process.platform === "win32" ? "junction" : "dir");
    expect(() => materializeSymlinks(b2)).toThrow(/outside the bundle/);
    expect(existsSync(path.join(b2, "node_modules", "pkg"))).toBe(true);
  });
});
