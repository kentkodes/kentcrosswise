// Which kind of build this is. KCW_ENV is inlined at build time by next.config.ts (`env`), so a
// prod build carries the constant "prod" and the preview-only module is dropped from its bundle.

import type * as PreviewLogin from "./preview-login";

export type KcwEnv = "prod" | "preview";

/** Parses KCW_ENV. Unset or empty means prod; anything unknown is a configuration error. */
export function parseKcwEnv(value: string | undefined): KcwEnv {
  if (value === undefined || value === "" || value === "prod") return "prod";
  if (value === "preview") return "preview";
  throw new Error(`KCW_ENV must be "prod" or "preview", got "${value}"`);
}

/**
 * The preview-only module (credentials provider + preview settings), or undefined in prod builds.
 *
 * Keep the `process.env.KCW_ENV === "preview"` test literal: Next replaces it with a constant at
 * build time and drops the dead `import()`, so the prod bundle never contains the preview provider.
 * `scripts/check-prod-bundle.ts` asserts that on the build output.
 */
export async function loadPreviewModule(): Promise<typeof PreviewLogin | undefined> {
  if (process.env.KCW_ENV === "preview") {
    return import("./preview-login");
  }
  return undefined;
}
