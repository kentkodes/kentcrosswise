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

// `<Xray ... id="x">` (the tag may span lines) and `<XrayStrip ids={["x", "y"]} />`.
const used = files(ROOT).flatMap((path) => {
  const src = readFileSync(path, "utf8");
  const tags = [...src.matchAll(/<Xray\b[^>]*?\bid="([^"]+)"/g)].map((m) => m[1]!);
  const strips = [...src.matchAll(/<XrayStrip\b[^>]*?\bids=\{\[([^\]]*)\]\}/g)].flatMap((m) =>
    [...m[1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]!),
  );
  return [...tags, ...strips];
});

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
