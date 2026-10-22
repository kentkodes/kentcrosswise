// Checks a deployed stack: `/` and `/demo` return 200, `/hub` redirects to the sign-in page.
// Usage: pnpm smoke-check --url https://<host> [--attempts <n>] [--delay <seconds>]
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { runSmoke } from "./lib/smoke";

const args = parseArgs(process.argv.slice(2));

function positiveInt(name: string, fallback: number): number {
  const v = args[name];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !/^[1-9][0-9]*$/.test(v)) throw new Error(`--${name} must be a positive integer`);
  return Number(v);
}

await runMain(async () => {
  if (typeof args.url !== "string") throw new Error("Usage: pnpm smoke-check --url https://<host> [--attempts <n>] [--delay <seconds>]");
  await runSmoke({ baseUrl: args.url, attempts: positiveInt("attempts", 10), delayMs: positiveInt("delay", 15) * 1000 });
});
