import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkAgentDocs } from "../check-agent-docs.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("canonical docs satisfy the integrity contract", () => {
  assert.deepEqual(checkAgentDocs(repo), []);
});

test("detects broken continuity boundaries in an isolated fixture", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kcw-docs-"));
  try {
    for (const file of ["docs", "apps/web/AGENTS.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "agents/merge-rules/approved-deps.json"]) {
      cpSync(path.join(repo, file), path.join(root, file), { recursive: true });
    }
    const edit = (file, transform) => writeFileSync(path.join(root, file), transform(readFileSync(path.join(root, file), "utf8")));
    edit("GEMINI.md", (text) => text.replace("docs/agents/INSTRUCTIONS.md)", "docs/agents/missing.md)"));
    edit("docs/agents/INSTRUCTIONS.md", (text) => `${text}\n[Bad heading](CONTINUITY.md#missing-heading)\n`);
    edit("docs/HANDOFF.md", (text) => text.replace("## Verification", "## Results") + "\nC:\\Users\\private-user\\work\\secret\n");
    edit("apps/web/AGENTS.md", (text) => text.replace("<!-- END:nextjs-agent-rules -->", ""));
    const errors = checkAgentDocs(root);
    for (const expected of ["thin mandatory pointer", "broken local link", "missing local heading", "missing section Verification", "local workspace/profile", "missing generated Next.js rules block"]) {
      assert.ok(errors.some((error) => error.includes(expected)), `${expected}: ${errors.join("; ")}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
