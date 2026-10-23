import { createPrivateKey, randomUUID } from "node:crypto";

const INVALID_KEY = "KCW_APP_PRIVATE_KEY must be a valid unencrypted RSA private key";

/** Recover PEM formatting lost in a single-line secret field, preserving the RSA identity. */
export function normalizePrivateKey(value: string): string {
  try {
    if (value.length > 65_536) throw new Error();
    const text = value.replace(/\\r\\n/g, "\n").replace(/\\n|\\r/g, "\n").replace(/\r\n?/g, "\n");
    const match = /^\s*-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([\s\S]*?)-----END \1-----\s*$/.exec(text);
    if (!match) throw new Error();
    const body = match[2]!.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body) || body.length % 4 !== 0) throw new Error();
    const pem = `-----BEGIN ${match[1]}-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END ${match[1]}-----\n`;
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
    return key.export({ format: "pem", type: "pkcs8" }).toString();
  } catch {
    // Crypto errors can carry input/context; never retain a cause or expose parser details.
    throw new Error(INVALID_KEY);
  }
}

interface KeyOutput {
  stdout: (command: string) => void;
  appendEnv: (file: string, value: string) => void;
}

/** Run only on a fresh trusted publisher: mask the new representation before exporting it. */
export function exportPublisherPrivateKey(env: Readonly<Record<string, string | undefined>>, output: KeyOutput): void {
  try {
    if (!env.KCW_APP_PRIVATE_KEY || !env.GITHUB_ENV) throw new Error();
    const normalized = normalizePrivateKey(env.KCW_APP_PRIVATE_KEY);
    // Same command-data escaping as @actions/core.setSecret, without another dependency.
    const escaped = normalized.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    output.stdout(`::add-mask::${escaped}\n`);
    const delimiter = `KCW_PRIVATE_KEY_${randomUUID()}`;
    output.appendEnv(env.GITHUB_ENV, `KCW_APP_PRIVATE_KEY<<${delimiter}\n${normalized}${delimiter}\n`);
  } catch {
    throw new Error("Publisher App private key preparation failed");
  }
}
