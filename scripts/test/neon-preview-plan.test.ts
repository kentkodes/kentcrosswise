import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expiresAt,
  formatOutputs,
  parsePrNumber,
  planOutputs,
  PREVIEW_TTL_HOURS,
  previewBranchName,
} from "../../.github/actions/neon-preview/plan";

const planScript = fileURLToPath(new URL("../../.github/actions/neon-preview/plan.ts", import.meta.url));

describe("neon-preview plan helper", () => {
  it("parses PR numbers, including 0 for the manual test", () => {
    expect(parsePrNumber("0")).toBe(0);
    expect(parsePrNumber(" 42 ")).toBe(42);
    for (const bad of [undefined, "", "-1", "01", "1.5", "pr-3", "1e3", "12345678901"]) {
      expect(() => parsePrNumber(bad)).toThrow(/PR_NUMBER/);
    }
  });

  it("names the branch preview/pr-<n>", () => {
    expect(previewBranchName(0)).toBe("preview/pr-0");
    expect(previewBranchName(123)).toBe("preview/pr-123");
  });

  it("expires 3 hours later, RFC 3339 UTC without milliseconds", () => {
    expect(PREVIEW_TTL_HOURS).toBe(3);
    expect(expiresAt(new Date("2026-10-22T22:30:15.789Z"))).toBe("2026-10-23T01:30:15Z");
    expect(expiresAt(new Date("2026-10-22T10:00:00Z"), 1)).toBe("2026-10-22T11:00:00Z");
    expect(() => expiresAt(new Date("nope"))).toThrow(/clock/);
    expect(() => expiresAt(new Date(), 0)).toThrow(/positive/);
  });

  it("builds and formats the step outputs", () => {
    const out = planOutputs({ PR_NUMBER: "7" }, new Date("2026-10-22T00:00:00Z"));
    expect(out).toEqual({ branch_name: "preview/pr-7", expires_at: "2026-10-22T03:00:00Z", preview_name: "pr-7" });
    expect(formatOutputs(out)).toBe(
      "branch_name=preview/pr-7\nexpires_at=2026-10-22T03:00:00Z\npreview_name=pr-7\n",
    );
    expect(() => formatOutputs({ x: "a\nb" })).toThrow(/newline/);
  });

  it("runs under plain node (type stripping) and writes GITHUB_OUTPUT", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kcw-neon-"));
    try {
      const outFile = path.join(dir, "out");
      execFileSync(process.execPath, [planScript], {
        env: { ...process.env, PR_NUMBER: "5", GITHUB_OUTPUT: outFile },
        stdio: "pipe",
      });
      expect(readFileSync(outFile, "utf8")).toMatch(/^branch_name=preview\/pr-5\nexpires_at=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\npreview_name=pr-5\n$/);
      expect(() =>
        execFileSync(process.execPath, [planScript], { env: { ...process.env, PR_NUMBER: "x" }, stdio: "pipe" }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
