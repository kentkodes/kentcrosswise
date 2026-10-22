// Builds apps/web for Lambda with OpenNext v4 and checks the output against the contract that
// infra/modules/web consumes (AGENTS.md, "OpenNext output contract").
// Usage: [KCW_ENV=prod|preview] pnpm build-web
// Prod builds (the default) also fail if the preview login provider is in the output.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import openNextConfig from "../apps/web/open-next.config";
import { parseKcwEnv } from "../apps/web/src/auth/env";
import { scanForMarkers } from "./lib/bundle-check";
import { runMain } from "./lib/main";
import { CONTRACT, checkOpenNextOutput } from "./lib/open-next-output";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(repoRoot, "apps", "web");
const outDir = path.join(webDir, ".open-next");

function run(cmd: string, args: string[], cwd: string): void {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
  if (res.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ""} failed (exit ${res.status ?? "signal"})`);
}

/**
 * OpenNext 4.1.12 installs sharp for the image function into a temp dir whose name it derives with
 * outputDir.split("/"), which breaks on Windows paths; it logs the error and carries on. On Windows
 * we do the same install ourselves (Linux arm64 binaries, same package list as open-next.config.ts).
 */
function ensureSharp(): void {
  const sharp = path.join(outDir, CONTRACT.image.sharp);
  if (existsSync(sharp)) return;
  if (process.platform !== "win32") throw new Error("OpenNext did not install sharp into the image function");
  const install = openNextConfig.imageOptimization.install;
  const tmp = mkdtempSync(path.join(tmpdir(), "kcw-sharp-"));
  try {
    console.log(`build-web: installing ${install.packages.join(" ")} for linux/${install.arch} (Windows workaround)`);
    // npm-cli.js next to node.exe: avoids spawning npm.cmd through a shell.
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    run(process.execPath, [npmCli, "install", "--no-save", "--no-package-lock", "--os=linux", `--cpu=${install.arch}`, "--libc=glibc", ...install.packages], tmp);
    cpSync(path.join(tmp, "node_modules"), path.join(outDir, CONTRACT.image.dir, "node_modules"), {
      recursive: true,
      force: true,
      dereference: true,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

await runMain(async () => {
  const kcwEnv = parseKcwEnv(process.env.KCW_ENV);
  process.env.KCW_ENV = kcwEnv;
  process.env.NEXT_TELEMETRY_DISABLED ??= "1";
  console.log(`build-web: KCW_ENV=${kcwEnv}`);

  // The package "exports" map hides package.json, so use the workspace symlink directly.
  const openNextBin = path.join(webDir, "node_modules", "@opennextjs", "aws", "dist", "index.js");
  run(process.execPath, [openNextBin, "build"], webDir);
  ensureSharp();

  const { problems, buildId } = checkOpenNextOutput(outDir);
  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`);
    throw new Error("the OpenNext output does not match the contract in AGENTS.md");
  }

  if (kcwEnv === "prod") {
    const dirs = [outDir, path.join(webDir, ".next", "server"), path.join(webDir, ".next", "static")];
    const { hits } = scanForMarkers(dirs);
    if (hits.length > 0) {
      for (const h of hits) console.error(`  ${path.relative(repoRoot, h.file)}: "${h.marker}"`);
      throw new Error("prod build contains the preview login provider");
    }
  }
  // infra/modules/web refuses to deploy a build made for the other environment (variable kcw_env).
  writeFileSync(path.join(outDir, "kcw-build.json"), `${JSON.stringify({ kcw_env: kcwEnv, build_id: buildId })}
`);
  console.log(`build-web: OK (BUILD_ID ${buildId}, output ${path.relative(repoRoot, outDir)})`);
});
