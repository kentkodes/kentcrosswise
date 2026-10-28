import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bundleLambda, LAMBDA_TARGETS, smokeImport } from "../lib/lambda-bundle";

it("watcher bundle imports outside the repo with no credentials or external effects", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dir = mkdtempSync(path.join(tmpdir(), "kcw-pipeline-bundle-"));
  try {
    const target = LAMBDA_TARGETS.find((t) => t.name === "watcher")!;
    const result = await bundleLambda(root, target, dir);
    expect(result.bytes).toBeGreaterThan(0);
    expect(smokeImport(result.file)).toEqual({ ok: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 60_000);
