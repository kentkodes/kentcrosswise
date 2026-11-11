// Checks a deployed stack: `/`, `/demo`, `/office` and `/bot` return 200 and, with --build-file,
// carry that build's id; `/hub` redirects to the sign-in page.
// Usage: pnpm smoke-check --url https://<host> [--attempts <n>] [--delay <seconds>] [--build-file <path>]
// --build-file is relative to the repo root (apps/web/.open-next/kcw-build.json from `pnpm build-web`).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { parseBuildFile, runSmoke } from "./lib/smoke";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));

function positiveInt(name: string, fallback: number): number {
  const v = args[name];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !/^[1-9][0-9]*$/.test(v)) throw new Error(`--${name} must be a positive integer`);
  return Number(v);
}

function buildId(): string | undefined {
  const v = args["build-file"];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error("--build-file needs a path");
  const file = path.resolve(repoRoot, v);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new Error(`--build-file not readable: ${v}`);
  }
  return parseBuildFile(text);
}

await runMain(async () => {
  if (typeof args.url !== "string") {
    throw new Error("Usage: pnpm smoke-check --url https://<host> [--attempts <n>] [--delay <seconds>] [--build-file <path>]");
  }
  const id = buildId();
  await runSmoke({ baseUrl: args.url, buildId: id, attempts: positiveInt("attempts", 10), delayMs: positiveInt("delay", 15) * 1000 });
});
