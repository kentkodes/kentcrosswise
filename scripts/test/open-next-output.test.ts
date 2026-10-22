import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkOpenNextOutput } from "../lib/open-next-output";

const root = mkdtempSync(path.join(tmpdir(), "kcw-opennext-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Shaped like the real `open-next build` output of @opennextjs/aws 4.1.12 with our open-next.config.ts.
const manifest = {
  edgeFunctions: {},
  origins: {
    s3: {
      type: "s3",
      originPath: "_assets",
      copy: [
        { from: ".open-next/assets", to: "_assets", cached: true, versionedSubDir: "_next" },
        { from: ".open-next/cache", to: "_cache", cached: false },
      ],
    },
    imageOptimizer: { type: "function", handler: "index.handler", bundle: ".open-next/image-optimization-function" },
    default: {
      type: "function",
      handler: "index.handler",
      bundle: ".open-next/server-functions/default",
      wrapper: "kcw-origin-guard",
      converter: "aws-apigw-v2",
      queue: "sqs-lite",
      incrementalCache: "s3-lite",
      tagCache: "dummy",
    },
  },
  behaviors: [],
  additionalProps: { revalidationFunction: { handler: "index.handler", bundle: ".open-next/revalidation-function" } },
};

function build(name: string, opts: { manifest?: unknown; omit?: string[] } = {}): string {
  const dir = path.join(root, name);
  const files: Record<string, string> = {
    "open-next.output.json": JSON.stringify(opts.manifest ?? manifest),
    "server-functions/default/index.mjs": "",
    "image-optimization-function/index.mjs": "",
    "image-optimization-function/node_modules/sharp/package.json": "{}",
    "revalidation-function/index.mjs": "",
    "assets/BUILD_ID": "build-123\n",
    "cache/build-123/route-cache/x.cache": "",
  };
  for (const [rel, body] of Object.entries(files)) {
    if (opts.omit?.includes(rel)) continue;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe("checkOpenNextOutput", () => {
  it("accepts the expected layout and reads the build id", () => {
    expect(checkOpenNextOutput(build("ok"))).toEqual({ problems: [], buildId: "build-123" });
  });

  it("reports a missing manifest", () => {
    expect(checkOpenNextOutput(path.join(root, "nothing")).problems).toEqual(["missing open-next.output.json"]);
  });

  it("reports missing sharp, entries and cache dir", () => {
    const res = checkOpenNextOutput(
      build("holes", {
        omit: [
          "image-optimization-function/node_modules/sharp/package.json",
          "revalidation-function/index.mjs",
          "cache/build-123/route-cache/x.cache",
        ],
      }),
    );
    expect(res.problems.join("\n")).toMatch(/sharp not installed/);
    expect(res.problems.join("\n")).toMatch(/missing revalidation-function\/index.mjs/);
    expect(res.problems.join("\n")).toMatch(/missing cache\/build-123/);
  });

  it("flags function splitting, edge functions and override drift", () => {
    const drifted = structuredClone(manifest) as typeof manifest & {
      origins: Record<string, unknown>;
      edgeFunctions: Record<string, unknown>;
    };
    drifted.origins.api = { type: "function", bundle: ".open-next/server-functions/api" };
    drifted.edgeFunctions.mw = {};
    drifted.origins.default.queue = "sqs";
    const problems = checkOpenNextOutput(build("drift", { manifest: drifted })).problems.join("\n");
    expect(problems).toMatch(/function splitting/);
    expect(problems).toMatch(/edge functions/);
    expect(problems).toMatch(/queue is sqs, expected sqs-lite/);
  });
});
