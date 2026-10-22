/**
 * Errors thrown by @kcw/secrets. Messages name the secret and key but never
 * contain a secret value (not even a fragment from a JSON parse error).
 */
export class SecretError extends Error {
  constructor(
    message: string,
    readonly secretName: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The secret or SSM parameter does not exist (or is not visible to this role). */
export class SecretNotFoundError extends SecretError {}

/** The secret exists but has no such key. */
export class SecretKeyMissingError extends SecretError {
  constructor(
    secretName: string,
    readonly key: string,
  ) {
    super(`Secret "${secretName}" has no key "${key}"`, secretName);
  }
}

/** The value is not in the expected shape (e.g. not a JSON object when a key was asked for). */
export class SecretFormatError extends SecretError {}

/** Any other failure talking to AWS (permissions, network, throttling). */
export class SecretAccessError extends SecretError {}
