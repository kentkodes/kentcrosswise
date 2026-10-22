/**
 * Tiny argv parser for repo scripts: `--flag`, `--key value`, `--key=value`.
 * Kept dependency-free so scripts run the same on Windows and Linux.
 */
export type ParsedArgs = Record<string, string | boolean>;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[body] = next;
      i++;
    } else {
      out[body] = true;
    }
  }
  return out;
}
