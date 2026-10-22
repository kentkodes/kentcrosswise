import { SecretStore, type SecretJson } from "./store";

export * from "./errors";
export { SecretStore, isSsmName } from "./store";
export type { SecretJson, SecretStoreOptions, SecretsManagerLike, SsmLike } from "./store";
export { FakeAwsSecrets, createFakeSecrets } from "./fake";

let defaultStore: SecretStore | undefined;

/** The process-wide store used by getSecret/putSecret/patchSecret (real AWS clients, created lazily). */
export function defaultSecretStore(): SecretStore {
  defaultStore ??= new SecretStore();
  return defaultStore;
}

/** Replace the process-wide store (tests), or pass undefined to reset it. */
export function setDefaultSecretStore(store: SecretStore | undefined): void {
  defaultStore = store;
}

/**
 * Read a secret. Names starting with "/" are SSM SecureString parameters, others Secrets Manager.
 * Without `key`: the parsed JSON object, or the raw string. With `key`: that key as a string.
 */
export function getSecret(name: string): Promise<string | SecretJson>;
export function getSecret(name: string, key: string): Promise<string>;
export function getSecret(name: string, key?: string): Promise<string | SecretJson> {
  return key === undefined ? defaultSecretStore().get(name) : defaultSecretStore().get(name, key);
}

/** Overwrite a secret (objects are stored as JSON). */
export function putSecret(name: string, value: string | SecretJson): Promise<void> {
  return defaultSecretStore().put(name, value);
}

/** Update some keys of a JSON secret, keeping the others (token rotation). */
export function patchSecret(name: string, patch: Readonly<Record<string, string>>): Promise<void> {
  return defaultSecretStore().patch(name, patch);
}
