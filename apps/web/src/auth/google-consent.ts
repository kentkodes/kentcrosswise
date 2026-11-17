// The Google scopes and the token secret helpers, with no next-auth import. The scheduled jobs reach this
// module through server/google.ts and are bundled into the OpenNext wrapper (and type-checked with the scripts
// package through scripts/build-web.ts), so it must stay free of next-auth and of the "@/" path alias.
import { defaultSecretStore, SecretNotFoundError, type SecretStore } from "@kcw/secrets";

/** Sign-in scopes only. Calendar is added by incremental consent from /connections. */
export const GOOGLE_SIGN_IN_SCOPES = "openid email profile";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
/** What the Connect button asks for. */
export const GOOGLE_CONNECT_SCOPES = `${GOOGLE_SIGN_IN_SCOPES} ${GOOGLE_CALENDAR_SCOPE}`;

/** Env var holding the *name* of the secret that stores the Google refresh token (D15). Unset: no connection. */
export const GOOGLE_TOKEN_SECRET_ENV = "KCW_GOOGLE_TOKEN_SECRET";

/**
 * Patches the keys of a JSON secret. A secret container with no value yet (bootstrap creates none) is created
 * with the new object instead; any other error is rethrown unchanged.
 */
export async function patchOrCreateSecret(
  name: string,
  patch: Readonly<Record<string, string>>,
  store: Pick<SecretStore, "patch" | "put"> = defaultSecretStore(),
): Promise<void> {
  try {
    await store.patch(name, patch);
  } catch (err) {
    if (!(err instanceof SecretNotFoundError)) throw err;
    await store.put(name, patch);
  }
}
