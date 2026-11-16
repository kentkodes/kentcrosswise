// The VAPID key pair from the web secret (keys vapid_public and vapid_private). Missing means "push is not set
// up" (null), not a failure; other secret errors propagate. Relative imports only: the job bundle has no `@/` alias.
import { SecretFormatError, SecretKeyMissingError, SecretNotFoundError, type SecretStore, defaultSecretStore } from "@kcw/secrets";
import type { VapidKeys } from "./vapid";

const WEB_SECRET_ENV = "KCW_WEB_SECRET";
const DEFAULT_WEB_SECRET = "kcw/prod/web";

export async function loadVapidKeys(
  env: Readonly<Record<string, string | undefined>> = process.env,
  store: Pick<SecretStore, "get"> = defaultSecretStore(),
): Promise<VapidKeys | null> {
  const name = env[WEB_SECRET_ENV] || DEFAULT_WEB_SECRET;
  try {
    const publicKey = (await store.get(name, "vapid_public")).trim();
    const privateKey = (await store.get(name, "vapid_private")).trim();
    return publicKey && privateKey ? { publicKey, privateKey } : null;
  } catch (err) {
    if (err instanceof SecretNotFoundError || err instanceof SecretKeyMissingError || err instanceof SecretFormatError) return null;
    throw err;
  }
}
