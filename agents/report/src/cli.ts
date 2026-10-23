// Entry point: pnpm kcw-report --task-id <n> --agent <agent> --event-type <type> [--dry-run] (see --help).
// Prints one line (or the JSON in dry-run); on failure prints the message only, no stack or objects.
import { runCli } from "./index";

try {
  await runCli(process.argv.slice(2), { env: process.env, stdout: (line) => console.log(line) });
} catch (err) {
  console.error(`kcw-report: ${err instanceof Error ? err.message : "unknown failure"}`);
  process.exitCode = 1;
}
