// PREVIEW BUILDS ONLY. Loaded through loadPreviewModule() in ./env, so it is compiled into the
// bundle only when KCW_ENV=preview at build time. Previews hold synthetic data only (D4).
import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "@kcw/secrets";
import Credentials from "next-auth/providers/credentials";
import type { AuthSettings, EnvLike } from "./settings";

/** Provider id. It doubles as the marker that scripts/check-prod-bundle.ts looks for. */
export const PREVIEW_PROVIDER_ID = "kcw-preview-login";

/** Synthetic owner identity of preview environments. */
export const PREVIEW_OWNER_EMAIL = "owner@preview.kentcrosswise.invalid";

/** Secret holding `e2e_login` (DESIGN §6). */
export const CI_SECRET_ENV = "KCW_CI_SECRET";
export const DEFAULT_CI_SECRET = "kcw/ci";

/** Local runs (Playwright against next dev/start) may pass the token directly instead. */
export const LOCAL_E2E_LOGIN_ENV = "KCW_E2E_LOGIN";

const MIN_TOKEN_LENGTH = 16;

/** Constant-time comparison of a submitted token with the expected one. */
export function checkPreviewToken(submitted: unknown, expected: string): boolean {
  if (typeof submitted !== "string" || submitted === "" || expected.length < MIN_TOKEN_LENGTH) return false;
  const a = createHash("sha256").update(submitted).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The preview JWT secret is derived from the e2e token, so previews need no second secret. */
export function derivePreviewAuthSecret(e2eLogin: string): string {
  return Buffer.from(hkdfSync("sha256", e2eLogin, "kcw-preview", "kcw preview auth secret", 32)).toString(
    "base64url",
  );
}

export async function loadPreviewSettings(env: EnvLike, store: SecretStore): Promise<AuthSettings> {
  const local = env[LOCAL_E2E_LOGIN_ENV];
  const e2eLogin =
    local !== undefined && local !== ""
      ? local
      : await store.get(env[CI_SECRET_ENV] || DEFAULT_CI_SECRET, "e2e_login");
  if (e2eLogin.length < MIN_TOKEN_LENGTH) {
    throw new Error(`The preview e2e login token must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return { authSecret: derivePreviewAuthSecret(e2eLogin), ownerEmail: PREVIEW_OWNER_EMAIL, e2eLogin };
}

export function previewLoginProvider(settings: AuthSettings) {
  const expected = settings.e2eLogin;
  return Credentials({
    id: PREVIEW_PROVIDER_ID,
    name: "Preview login",
    credentials: { token: { label: "Preview login token", type: "password" } },
    authorize: async (credentials) => {
      if (expected === undefined || !checkPreviewToken(credentials?.token, expected)) return null;
      return { id: "preview-owner", email: PREVIEW_OWNER_EMAIL, name: "Preview owner" };
    },
  });
}
