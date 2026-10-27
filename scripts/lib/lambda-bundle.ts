// Bundles the four Lambdas (orchestrator, webhook relay, sweeper, essay watcher) into one ESM file
// each with esbuild. infra/modules/orchestrator, infra/modules/scheduler and infra/modules/pipelines
// zip each output directory (archive_file) and run `index.handler` on nodejs24.x / arm64; infra/prod
// points each target's `prodVar` (orchestrator_package_dir, relay_package_dir, sweeper_package_dir,
// pipeline_package_dir) here.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { build, type BuildOptions } from "esbuild";

export interface LambdaTarget {
  /** Short name, also the Terraform resource name (aws_lambda_function.<name>) in `tfFile`. */
  name: "orchestrator" | "relay" | "sweeper" | "watcher";
  /** Repo-relative Terraform file declaring the function. */
  tfFile: string;
  /** infra/prod variable whose default is `../../<outDir>`. */
  prodVar: string;
  /** Separate optional stack file for modules that extend the production stack. */
  prodTfFile?: string;
  /** Entry module (repo-relative). */
  entry: string;
  /** Output directory (repo-relative); the bundle is `<outDir>/index.mjs`. */
  outDir: string;
  /** Must match `architectures` of the function (checked by a test against lambda.tf). */
  arch: "arm64" | "x86_64";
}

export const LAMBDA_TARGETS: readonly LambdaTarget[] = [
  {
    name: "orchestrator",
    tfFile: "infra/modules/orchestrator/lambda.tf",
    prodVar: "orchestrator_package_dir",
    entry: "agents/orchestrator/src/lambda.ts",
    outDir: "agents/orchestrator/dist",
    arch: "arm64",
  },
  {
    name: "relay",
    tfFile: "infra/modules/orchestrator/lambda.tf",
    prodVar: "relay_package_dir",
    entry: "agents/webhook-relay/src/lambda.ts",
    outDir: "agents/webhook-relay/dist",
    arch: "arm64",
  },
  {
    name: "sweeper",
    tfFile: "infra/modules/scheduler/main.tf",
    prodVar: "sweeper_package_dir",
    entry: "agents/orchestrator/src/sweeper/entry.ts",
    outDir: "agents/orchestrator/dist-sweeper",
    arch: "arm64",
  },
  {
    name: "watcher",
    tfFile: "infra/modules/pipelines/main.tf",
    prodVar: "pipeline_package_dir",
    prodTfFile: "infra/prod/pipelines.tf",
    entry: "scripts/lib/pipelines/entry.ts",
    outDir: "scripts/dist-pipelines",
    arch: "arm64",
  },
];

export const BUNDLE_FILE = "index.mjs";

/**
 * Bundled ESM still contains CommonJS dependencies (pg, parts of the AWS SDK) that call
 * `require("net")` etc. esbuild turns those into a `__require` helper that only works if a
 * `require` is in scope, so the bundle defines one.
 */
const CJS_SHIM = [
  'import { createRequire as __kcwCreateRequire } from "node:module";',
  "const require = __kcwCreateRequire(import.meta.url);",
].join("\n");

/**
 * Left out of the bundle. All are optional and only loaded in code paths Lambda never takes:
 * `pg-native` (pg's native client, only via `pg.native`) and `pg-cloudflare` /
 * `cloudflare:sockets` (pg's Cloudflare Workers socket). Bundling them would pull in native or
 * Workers-only code; leaving them external keeps the bundle pure JavaScript, so it runs on arm64
 * and x86_64 alike.
 */
export const EXTERNALS = ["pg-native", "pg-cloudflare", "cloudflare:sockets"] as const;

export function esbuildOptions(repoRoot: string, target: LambdaTarget, outDir?: string): BuildOptions {
  return {
    absWorkingDir: repoRoot,
    entryPoints: [path.join(repoRoot, target.entry)],
    outfile: path.join(outDir ?? path.join(repoRoot, target.outDir), BUNDLE_FILE),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    // ESM builds of dependencies first (the AWS SDK ships both): better tree shaking.
    mainFields: ["module", "main"],
    external: [...EXTERNALS],
    banner: { js: CJS_SHIM },
    // The AWS SDK v3 is bundled, not taken from the runtime: the version is the one in the lockfile.
    minify: true,
    // Error and class names stay readable: our logs print err.name, and LangChain derives
    // serialization ids from class names.
    keepNames: true,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  };
}

export interface BundleResult {
  target: LambdaTarget;
  file: string;
  bytes: number;
  /** Deflated size of the bundle: about what the Lambda zip will be. */
  zipBytes: number;
}

export async function bundleLambda(repoRoot: string, target: LambdaTarget, outDir?: string): Promise<BundleResult> {
  const dir = outDir ?? path.join(repoRoot, target.outDir);
  rmSync(dir, { recursive: true, force: true });
  const opts = esbuildOptions(repoRoot, target, dir);
  const res = await build(opts);
  if (res.errors.length > 0) throw new Error(`esbuild failed for ${target.name}`);
  const file = opts.outfile!;
  const bundled = Object.keys(res.metafile?.inputs ?? {});
  const native = bundled.filter((p) => p.endsWith(".node"));
  if (native.length > 0) throw new Error(`${target.name}: native addons in the bundle (${native.join(", ")})`);
  return {
    target,
    file,
    bytes: statSync(file).size,
    zipBytes: deflateRawSync(readFileSync(file), { level: 9 }).length,
  };
}

export type SmokeResult = { ok: true } | { ok: false; reason: string };

/**
 * Imports a built bundle in a fresh Node process from a temp directory outside the repo, so no
 * node_modules can satisfy an import the bundle failed to include, and checks that it exports a
 * `handler` function. Nothing is invoked and no AWS call is made at import time.
 */
export function smokeImport(bundleFile: string, env: NodeJS.ProcessEnv = {}): SmokeResult {
  const dir = mkdtempSync(path.join(tmpdir(), "kcw-lambda-"));
  try {
    const copy = path.join(dir, BUNDLE_FILE);
    copyFileSync(bundleFile, copy);
    const script = [
      'import { pathToFileURL } from "node:url";',
      "const m = await import(pathToFileURL(process.argv[1]).href);",
      'if (typeof m.handler !== "function") { console.error("handler is " + typeof m.handler); process.exit(2); }',
    ].join("\n");
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script, copy], {
      cwd: dir,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      encoding: "utf8",
      timeout: 60_000,
    });
    if (res.status === 0) return { ok: true };
    const reason = (res.stderr || res.stdout || `exit ${res.status ?? "signal"}`).trim().split("\n").slice(0, 5).join(" | ");
    return { ok: false, reason };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}
