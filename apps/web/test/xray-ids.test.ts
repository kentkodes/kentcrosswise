import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { XRAY_IDS } from "@kcw/xray";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../src/app/(public)");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx$/.test(name) ? [path] : [];
  });
}

const used = files(ROOT).flatMap((path) =>
  [...readFileSync(path, "utf8").matchAll(/<Xray\s+id="([^"]+)"/g)].map((m) => m[1]!),
);

describe("X-ray annotations on the public pages", () => {
  it("annotates the site", () => {
    expect(used.length).toBeGreaterThanOrEqual(8);
  });

  it("every id used exists in the registry", () => {
    for (const id of used) expect(XRAY_IDS, id).toContain(id);
  });

  it("every registry entry is used by a public page", () => {
    for (const id of XRAY_IDS) expect(used, id).toContain(id);
  });
});
