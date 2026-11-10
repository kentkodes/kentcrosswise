import type { ParsedArgs } from "./args";

/**
 * A script that writes may run against a local PGlite directory freely; any other target (a secret
 * or DATABASE_URL, i.e. a real database) needs an explicit --confirm. Checked before connecting.
 */
export function assertWriteAllowed(args: ParsedArgs, what: string): void {
  if (typeof args.pglite === "string" || args.confirm === true) return;
  throw new Error(`${what} writes to a non-PGlite database: rerun with --confirm after checking the target`);
}
