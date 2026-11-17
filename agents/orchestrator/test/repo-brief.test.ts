// AR5a: the repository brief is the Layout section of docs/agents/INSTRUCTIONS.md, bounded.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_REPO_BRIEF_BYTES, REPO_BRIEF_PATH, repoBrief } from "../src/nodes/repo-brief";

describe("repoBrief", () => {
  it("takes the Layout section up to the next section", () => {
    expect(repoBrief("# T\n\n## Toolchain\n\na\n\n## Layout\n\nx/  one\ny/  two\n\n## Rules\n\nr\n")).toBe("## Layout\n\nx/  one\ny/  two");
  });

  it("takes the section at the end of the file and tolerates CRLF", () => {
    expect(repoBrief("## Layout\r\n\r\nx/  one\r\n")).toBe("## Layout\n\nx/  one");
  });

  it("is null when the section is missing or empty", () => {
    expect(repoBrief("# T\n\n## Rules\n\nr\n")).toBeNull();
    expect(repoBrief("## Layout\n\n## Rules\n")).toBeNull();
    expect(repoBrief("### Layout\n\nx\n")).toBeNull();
  });

  it("is null above the byte bound and accepts exactly the bound", () => {
    const filler = (n: number) => "x".repeat(n - "## Layout\n\n".length);
    expect(repoBrief(`## Layout\n\n${filler(MAX_REPO_BRIEF_BYTES)}`)).not.toBeNull();
    expect(repoBrief(`## Layout\n\n${filler(MAX_REPO_BRIEF_BYTES + 1)}`)).toBeNull();
    expect(repoBrief(`## Layout\n\n${"é".repeat(MAX_REPO_BRIEF_BYTES / 2)}`)).toBeNull(); // bytes, not characters
  });

  it("the real instructions file has a Layout section within the bound", () => {
    const text = readFileSync(new URL(`../../../${REPO_BRIEF_PATH}`, import.meta.url), "utf8");
    const brief = repoBrief(text);
    expect(brief).not.toBeNull();
    expect(brief!.startsWith("## Layout")).toBe(true);
    expect(brief).toContain("agents/orchestrator/");
    expect(Buffer.byteLength(brief!, "utf8")).toBeLessThanOrEqual(MAX_REPO_BRIEF_BYTES);
  });
});
