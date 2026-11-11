// The Newsreader variable (--font-reading) is set on the essay article only, so the reading font never reaches
// the headings, the rating form or the rest of the page. A cheap source-text check, like owner-pages-auth.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const readerPage = fileURLToPath(new URL("../src/app/(owner)/essays/[id]/page.tsx", import.meta.url));

describe("essay reader font", () => {
  it("applies the reading font variable to the article element only", () => {
    const lines = readFileSync(readerPage, "utf8").split("\n");
    const uses = lines.filter((line) => line.includes("newsreader.variable"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toContain("<article");
  });
});
