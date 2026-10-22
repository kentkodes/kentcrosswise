import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateDemoData } from "../src/index";

// Reserved for documentation/testing (RFC 2606 / RFC 6761); anything else counts as real-looking.
const RESERVED = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const PHONE = /\+?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;

function realLookingEmails(text: string): string[] {
  return [...text.matchAll(EMAIL)].filter((m) => !RESERVED.test(m[1] ?? "")).map((m) => m[0]);
}

const repo = fileURLToPath(new URL("../../../", import.meta.url));
/** Synthetic-data sources: the generator and the DB seeds. */
const SCAN_DIRS = ["packages/demo-data/src", "packages/db/seeds"];

function filesUnder(dir: string): string[] {
  const abs = join(repo, dir);
  let names: string[];
  try {
    names = readdirSync(abs);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(abs, n);
    return statSync(p).isDirectory() ? filesUnder(join(dir, n)) : [p];
  });
}

describe("no real-looking personal data", () => {
  it("the matcher works", () => {
    expect(realLookingEmails("a@example.com b@x.invalid c@d.test")).toEqual([]);
    expect(realLookingEmails("someone@gmail.com")).toEqual(["someone@gmail.com"]);
  });

  it("generated data has no real-looking emails or phone numbers", () => {
    for (const seed of ["kcw-demo", "ci", "other"]) {
      const json = JSON.stringify(generateDemoData({ seed }));
      expect(realLookingEmails(json)).toEqual([]);
      expect(json.match(PHONE) ?? []).toEqual([]);
    }
  });

  it("generator and seed source files contain no real-looking emails", () => {
    const files = SCAN_DIRS.flatMap(filesUnder);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect({ file: f, emails: realLookingEmails(readFileSync(f, "utf8")) }).toEqual({ file: f, emails: [] });
    }
  });
});
