import {
  GetSecretValueCommand,
  PutSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { SecretStore, isSsmName, type SecretJson, type SecretsManagerLike, type SsmLike } from "./store";

function awsError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

/**
 * In-memory stand-in for both AWS clients. It records every command and can be told to fail.
 * Values are kept as raw strings, exactly like AWS.
 */
export class FakeAwsSecrets implements SecretsManagerLike, SsmLike {
  readonly values = new Map<string, string>();
  readonly calls: { command: string; name: string }[] = [];
  /** If set, the next `send` throws an error with this AWS error name. */
  failNextWith: string | undefined;

  constructor(initial: Readonly<Record<string, string | SecretJson>> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.values.set(name, typeof value === "string" ? value : JSON.stringify(value));
    }
  }

  async send(
    command: GetSecretValueCommand | PutSecretValueCommand | GetParameterCommand | PutParameterCommand,
  ): Promise<unknown> {
    if (command instanceof GetSecretValueCommand) return this.#get("GetSecretValue", command.input.SecretId, false);
    if (command instanceof GetParameterCommand) {
      if (command.input.WithDecryption !== true) throw new Error("fake: GetParameter without WithDecryption");
      return this.#get("GetParameter", command.input.Name, true);
    }
    if (command instanceof PutSecretValueCommand) {
      return this.#put("PutSecretValue", command.input.SecretId, command.input.SecretString, false);
    }
    if (command instanceof PutParameterCommand) {
      if (command.input.Type !== "SecureString" || command.input.Overwrite !== true) {
        throw new Error("fake: PutParameter must be a SecureString with Overwrite");
      }
      return this.#put("PutParameter", command.input.Name, command.input.Value, true);
    }
    throw new Error("fake: unsupported command");
  }

  #check(command: string, name: string | undefined, ssm: boolean): string {
    if (name === undefined) throw new Error(`fake: ${command} without a name`);
    if (isSsmName(name) !== ssm) throw new Error(`fake: ${command} called for "${name}"`);
    this.calls.push({ command, name });
    if (this.failNextWith !== undefined) {
      const failure = this.failNextWith;
      this.failNextWith = undefined;
      throw awsError(failure);
    }
    return name;
  }

  #get(command: string, rawName: string | undefined, ssm: boolean): unknown {
    const name = this.#check(command, rawName, ssm);
    const value = this.values.get(name);
    if (value === undefined) throw awsError(ssm ? "ParameterNotFound" : "ResourceNotFoundException");
    return ssm ? { Parameter: { Name: name, Value: value } } : { Name: name, SecretString: value };
  }

  #put(command: string, rawName: string | undefined, value: string | undefined, ssm: boolean): unknown {
    const name = this.#check(command, rawName, ssm);
    if (value === undefined) throw new Error(`fake: ${command} without a value`);
    this.values.set(name, value);
    return {};
  }
}

/** A real SecretStore backed by the in-memory fake. Use it in tests of code that needs secrets. */
export function createFakeSecrets(initial: Readonly<Record<string, string | SecretJson>> = {}): {
  store: SecretStore;
  aws: FakeAwsSecrets;
} {
  const aws = new FakeAwsSecrets(initial);
  return { store: new SecretStore({ secretsManager: aws, ssm: aws }), aws };
}
