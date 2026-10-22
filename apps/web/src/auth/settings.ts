import type { SecretStore } from "@kcw/secrets";

/** Everything the Auth.js config needs at runtime. Never log this object. */
export interface AuthSettings {
  authSecret: string;
  ownerEmail: string;
  /** Present in prod builds. */
  google?: { clientId: string; clientSecret: string };
  /** Present in preview builds: the shared e2e login token. */
  e2eLogin?: string;
}

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Env var holding the *name* of the web secret (D9: env vars hold names, never values). */
export const WEB_SECRET_ENV = "KCW_WEB_SECRET";
export const DEFAULT_WEB_SECRET = "kcw/prod/web";

/** Prod: everything comes from the web secret (DESIGN §6 keys). */
export async function loadProdSettings(env: EnvLike, store: SecretStore): Promise<AuthSettings> {
  const name = env[WEB_SECRET_ENV] || DEFAULT_WEB_SECRET;
  const [authSecret, ownerEmail, clientId, clientSecret] = await Promise.all([
    store.get(name, "auth_secret"),
    store.get(name, "owner_email"),
    store.get(name, "google_client_id"),
    store.get(name, "google_client_secret"),
  ]);
  if (authSecret.length < 32) {
    throw new Error(`Secret "${name}" key "auth_secret" must be at least 32 characters`);
  }
  if (!ownerEmail.includes("@")) {
    throw new Error(`Secret "${name}" key "owner_email" is not an email address`);
  }
  return { authSecret, ownerEmail, google: { clientId, clientSecret } };
}
