// Structural guard for the (owner) area. The (owner) layout redirects visitors, but Next renders a
// layout and its page in parallel, so each page must call requireOwner() itself as its first
// statement, before any query or data access. This is a cheap source-text check so that a new owner
// page cannot skip the call unnoticed.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ownerDir = fileURLToPath(new URL("../src/app/(owner)", import.meta.url));

const IMPORT_OWNER = /import\s*\{\s*requireOwner\s*\}\s*from\s*"@\/server\/owner"/;
const FIRST_STATEMENT = "await requireOwner();";

// Index just past the whitespace and comments that start at i.
function skipTrivia(src: string, i: number): number {
  for (;;) {
    while (i < src.length && /\s/.test(src.charAt(i))) i++;
    if (src.startsWith("//", i)) {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end + 1;
    } else if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      return i;
    }
  }
}

// Returns the first statement of the default export's body, or null when there is no default export.
// Parameter lists in these pages contain nested braces, so the parameter list is matched by parentheses.
export function firstStatementOfDefaultExport(src: string): string | null {
  const at = src.indexOf("export default");
  if (at === -1) return null;
  const open = src.indexOf("(", at);
  if (open === -1) return null;
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src.charAt(i) === "(") depth++;
    else if (src.charAt(i) === ")" && --depth === 0) break;
  }
  const brace = skipTrivia(src, i + 1);
  if (src[brace] !== "{") return null;
  const body = skipTrivia(src, brace + 1);
  return src.slice(body, body + FIRST_STATEMENT.length);
}

export function checkOwnerPage(src: string): string[] {
  const problems: string[] = [];
  if (!IMPORT_OWNER.test(src)) problems.push('missing `import { requireOwner } from "@/server/owner"`');
  const first = firstStatementOfDefaultExport(src);
  if (first === null) problems.push("no default export with a function body");
  else if (first !== FIRST_STATEMENT) problems.push(`first statement of the default export is not \`${FIRST_STATEMENT}\``);
  return problems;
}

function ownerPages(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((p) => basename(p) === "page.tsx")
    .map((p) => join(dir, p));
}

describe("owner pages call requireOwner() first", () => {
  const pages = ownerPages(ownerDir);

  it("finds the owner pages", () => {
    // Known pages: hub, console, console/usage, inbox, essays, essays/setup, essays/[id].
    expect(pages.length).toBeGreaterThanOrEqual(7);
  });

  for (const page of pages) {
    it(`${page.slice(ownerDir.length + 1)} imports and awaits requireOwner() before anything else`, () => {
      expect(checkOwnerPage(readFileSync(page, "utf8"))).toEqual([]);
    });
  }

  it("the checker rejects a page that queries before the owner check", () => {
    const bad = [
      'import { requireOwner } from "@/server/owner";',
      "export default async function P({ searchParams }: { searchParams: Promise<Record<string, string>> }) {",
      "  const rows = await withDb('web_rw', (db) => listTasks(db));",
      "  await requireOwner();",
      "  return null;",
      "}",
    ].join("\n");
    expect(checkOwnerPage(bad)).toEqual(["first statement of the default export is not `await requireOwner();`"]);
  });

  it("the checker rejects a page that never imports requireOwner", () => {
    const bad = "export default async function P() {\n  return null;\n}\n";
    expect(checkOwnerPage(bad)).toEqual([
      'missing `import { requireOwner } from "@/server/owner"`',
      "first statement of the default export is not `await requireOwner();`",
    ]);
  });

  it("the checker accepts a comment before the owner check", () => {
    const ok = [
      'import { requireOwner } from "@/server/owner";',
      "export default async function P() {",
      "  // owner only",
      "  /* first */",
      "  await requireOwner();",
      "  return null;",
      "}",
    ].join("\n");
    expect(checkOwnerPage(ok)).toEqual([]);
  });
});
