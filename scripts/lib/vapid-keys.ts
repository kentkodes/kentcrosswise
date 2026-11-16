// Generates a VAPID P-256 key pair and patches vapid_public / vapid_private into a JSON secret. Prints only a
// fixed line, never a key. Existing keys are kept unless `rotate` is set (rotating invalidates every subscription).
import { createECDH } from "node:crypto";
import type { SecretStore } from "@kcw/secrets";

export const VAPID_WRITTEN_LINE = "vapid keys written";

export class VapidKeysExistError extends Error {
  override name = "VapidKeysExistError";
}

export async function writeVapidKeys(
  store: Pick<SecretStore, "get" | "patch">,
  secretName: string,
  opts: { rotate?: boolean } = {},
): Promise<string> {
  const current = await store.get(secretName);
  if (typeof current === "string") throw new Error("the secret is not a JSON object");
  const has = (k: string) => typeof current[k] === "string" && (current[k] as string).trim() !== "";
  if (!opts.rotate && (has("vapid_public") || has("vapid_private"))) {
    throw new VapidKeysExistError("vapid keys already exist in the secret; pass --rotate to replace them");
  }
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  await store.patch(secretName, {
    vapid_public: ecdh.getPublicKey().toString("base64url"),
    vapid_private: ecdh.getPrivateKey().toString("base64url"),
  });
  return VAPID_WRITTEN_LINE;
}
