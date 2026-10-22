import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  SecretAccessError,
  SecretError,
  SecretFormatError,
  SecretKeyMissingError,
  SecretNotFoundError,
} from "./errors";

/** The part of the AWS SDK v3 Secrets Manager client we use. Inject a fake in tests. */
export interface SecretsManagerLike {
  send(command: GetSecretValueCommand | PutSecretValueCommand): Promise<unknown>;
}

/** The part of the AWS SDK v3 SSM client we use. Inject a fake in tests. */
export interface SsmLike {
  send(command: GetParameterCommand | PutParameterCommand): Promise<unknown>;
}

export type SecretJson = Readonly<Record<string, unknown>>;

export interface SecretStoreOptions {
  /** Defaults to a real client in `region`, created on first use. */
  secretsManager?: SecretsManagerLike;
  /** Defaults to a real client in `region`, created on first use. */
  ssm?: SsmLike;
  /** Defaults to AWS_REGION, then us-east-1 (D23). */
  region?: string;
}

/** Names starting with "/" are SSM Parameter Store SecureStrings (D21); everything else is Secrets Manager. */
export function isSsmName(name: string): boolean {
  return name.startsWith("/");
}

const NOT_FOUND = new Set(["ResourceNotFoundException", "ParameterNotFound"]);

function errorName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "name" in err && typeof err.name === "string"
    ? err.name
    : undefined;
}

/**
 * Reads and writes secrets with a per-process cache.
 *
 * - `get(name)` returns the parsed JSON object, or the raw string if the value is not a JSON object.
 * - `get(name, key)` returns one key of a JSON secret as a string.
 * - Concurrent reads of the same name share one AWS call; failed reads are not cached.
 */
export class SecretStore {
  readonly #opts: SecretStoreOptions;
  readonly #cache = new Map<string, Promise<string>>();
  #sm: SecretsManagerLike | undefined;
  #ssm: SsmLike | undefined;

  constructor(opts: SecretStoreOptions = {}) {
    this.#opts = opts;
    this.#sm = opts.secretsManager;
    this.#ssm = opts.ssm;
  }

  get(name: string): Promise<string | SecretJson>;
  get(name: string, key: string): Promise<string>;
  async get(name: string, key?: string): Promise<string | SecretJson> {
    const raw = await this.#raw(name);
    if (key === undefined) {
      return tryParseObject(raw) ?? raw;
    }
    const obj = tryParseObject(raw);
    if (!obj) {
      throw new SecretFormatError(`Secret "${name}" is not a JSON object, so key "${key}" cannot be read`, name);
    }
    if (!Object.hasOwn(obj, key)) throw new SecretKeyMissingError(name, key);
    const value = obj[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    throw new SecretFormatError(`Secret "${name}" key "${key}" is not a string`, name);
  }

  /** Replaces the whole value. Objects are stored as JSON. Updates the cache. */
  async put(name: string, value: string | SecretJson): Promise<void> {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    try {
      if (isSsmName(name)) {
        await this.#ssmClient().send(
          new PutParameterCommand({ Name: name, Value: raw, Type: "SecureString", Overwrite: true }),
        );
      } else {
        await this.#smClient().send(new PutSecretValueCommand({ SecretId: name, SecretString: raw }));
      }
    } catch (err) {
      throw mapAwsError(err, name, "write");
    }
    this.#cache.set(name, Promise.resolve(raw));
  }

  /**
   * Read-modify-write of some keys of a JSON secret (token rotation).
   * Reads the current value fresh from AWS, not from the cache.
   */
  async patch(name: string, patch: Readonly<Record<string, string>>): Promise<void> {
    this.#cache.delete(name);
    const current = await this.get(name);
    if (typeof current === "string") {
      throw new SecretFormatError(`Secret "${name}" is not a JSON object, so it cannot be patched`, name);
    }
    await this.put(name, { ...current, ...patch });
  }

  /** Forget one cached secret, or all of them. */
  clearCache(name?: string): void {
    if (name === undefined) this.#cache.clear();
    else this.#cache.delete(name);
  }

  #raw(name: string): Promise<string> {
    const hit = this.#cache.get(name);
    if (hit) return hit;
    const pending = this.#fetch(name);
    this.#cache.set(name, pending);
    pending.catch(() => {
      if (this.#cache.get(name) === pending) this.#cache.delete(name);
    });
    return pending;
  }

  async #fetch(name: string): Promise<string> {
    try {
      if (isSsmName(name)) {
        const out = (await this.#ssmClient().send(
          new GetParameterCommand({ Name: name, WithDecryption: true }),
        )) as { Parameter?: { Value?: string } };
        const value = out.Parameter?.Value;
        if (value === undefined) throw new SecretNotFoundError(`Parameter "${name}" has no value`, name);
        return value;
      }
      const out = (await this.#smClient().send(new GetSecretValueCommand({ SecretId: name }))) as {
        SecretString?: string;
        SecretBinary?: Uint8Array;
      };
      if (out.SecretString !== undefined) return out.SecretString;
      if (out.SecretBinary !== undefined) return new TextDecoder().decode(out.SecretBinary);
      throw new SecretNotFoundError(`Secret "${name}" has no value`, name);
    } catch (err) {
      throw mapAwsError(err, name, "read");
    }
  }

  #region(): string {
    return this.#opts.region ?? process.env.AWS_REGION ?? "us-east-1";
  }

  #smClient(): SecretsManagerLike {
    this.#sm ??= new SecretsManagerClient({ region: this.#region() });
    return this.#sm;
  }

  #ssmClient(): SsmLike {
    this.#ssm ??= new SSMClient({ region: this.#region() });
    return this.#ssm;
  }
}

function tryParseObject(raw: string): SecretJson | undefined {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.freeze(parsed as Record<string, unknown>)
      : undefined;
  } catch {
    // Do not rethrow: JSON.parse messages quote part of the input (the secret).
    return undefined;
  }
}

function mapAwsError(err: unknown, name: string, op: "read" | "write"): SecretError {
  if (err instanceof SecretError) return err;
  const awsName = errorName(err);
  if (awsName !== undefined && NOT_FOUND.has(awsName)) {
    return new SecretNotFoundError(`Secret "${name}" not found`, name, { cause: err });
  }
  return new SecretAccessError(`Could not ${op} secret "${name}" (${awsName ?? "unknown error"})`, name, {
    cause: err,
  });
}
