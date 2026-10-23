import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluate } from "../../agents/merge-rules/src/index";
import { exportPublisherPrivateKey, normalizePrivateKey } from "../lib/agent-private-key";

// Ephemeral fixtures stay in memory. Assertions never compare/export private values into diffs.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const forms = {
  canonical: pem,
  crlf: pem.replace(/\n/g, "\r\n"),
  "literal-newlines": pem.replace(/\n/g, "\\n"),
  "flattened-spaces": pem.replace(/\n/g, " "),
  "collapsed-body": pem.replace(/\n/g, ""),
  "literal-crlf": pem.replace(/\n/g, "\\r\\n"),
  "pkcs8-canonical": pkcs8,
  "pkcs8-literal-newlines": pkcs8.replace(/\n/g, "\\n"),
  "pkcs8-flattened": pkcs8.replace(/\n/g, " "),
  "mixed-whitespace": ` \t${pem.replace(/\n/g, " \t\r\n")}\n`,
};
const fingerprint = (value: ReturnType<typeof createPublicKey>) =>
  createHash("sha256").update(value.export({ format: "der", type: "spki" })).digest("hex");

describe("publisher App key normalization", () => {
  it.each(Object.keys(forms))("%s preserves the RSA identity and real signing behavior", (form) => {
    let parsed: ReturnType<typeof createPrivateKey>;
    try {
      parsed = createPrivateKey(normalizePrivateKey(forms[form as keyof typeof forms]));
    } catch {
      // Native createPrivateKey reproduces the action's DECODER seam without fixture leakage.
      throw new Error("RSA key rejected at Node DECODER boundary");
    }
    expect(fingerprint(createPublicKey(parsed))).toBe(fingerprint(publicKey));
    const data = Buffer.from("ephemeral publisher JWT signing fixture");
    expect(verify("RSA-SHA256", data, publicKey, sign("RSA-SHA256", data, parsed))).toBe(true);
    expect(normalizePrivateKey(forms[form as keyof typeof forms]) === pkcs8).toBe(true);
  });

  const invalid = {
    empty: "",
    "bad-body": "-----BEGIN PRIVATE KEY-----\nPRIVATE_MARKER%::error::\n-----END PRIVATE KEY-----",
    "truncated-der": "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
    "mismatched-wrapper": pem.replace("END RSA PRIVATE KEY", "END PRIVATE KEY"),
    "public-key": publicKey.export({ format: "pem", type: "spki" }).toString(),
    "non-rsa": generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    encrypted: privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "ephemeral-test-only" }).toString(),
    "extra-command": `${pem}\n::error::PRIVATE_MARKER`,
  };
  it.each(Object.keys(invalid))("rejects %s with one redacted error and no cause", (name) => {
    let error: unknown;
    try { normalizePrivateKey(invalid[name as keyof typeof invalid]); } catch (caught) { error = caught; }
    expect(error instanceof Error).toBe(true);
    expect((error as Error).message).toBe("KCW_APP_PRIVATE_KEY must be a valid unencrypted RSA private key");
    expect((error as Error).cause).toBeUndefined();
  });

  it("registers one escaped mask before appending only canonical PEM to GITHUB_ENV", () => {
    const calls: string[] = [];
    let mask = "", file = "", value = "";
    exportPublisherPrivateKey({ KCW_APP_PRIVATE_KEY: forms["literal-newlines"], GITHUB_ENV: "runner-owned-env" }, {
      stdout: (command) => { calls.push("mask"); mask = command; },
      appendEnv: (target, body) => { calls.push("env"); file = target; value = body; },
    });
    expect(calls).toEqual(["mask", "env"]);
    expect(file).toBe("runner-owned-env");
    expect(mask.startsWith("::add-mask::")).toBe(true);
    expect(mask.split("\n").length).toBe(2); // only the command terminator is a raw newline
    expect(mask.includes("%0A")).toBe(true);
    const decoded = mask.slice("::add-mask::".length, -1).replace(/%0A/g, "\n").replace(/%0D/g, "\r").replace(/%25/g, "%");
    expect(decoded === pkcs8).toBe(true);
    const delimiter = value.slice(0, value.indexOf("\n")).split("<<")[1]!;
    expect(/^KCW_PRIVATE_KEY_[\da-f-]{36}$/.test(delimiter)).toBe(true);
    expect(value === `KCW_APP_PRIVATE_KEY<<${delimiter}\n${pkcs8}${delimiter}\n`).toBe(true);
  });

  it("does not export when masking fails and never retains the sensitive callback error", () => {
    let appended = false, error: unknown;
    try {
      exportPublisherPrivateKey({ KCW_APP_PRIVATE_KEY: pem, GITHUB_ENV: "runner-owned-env" }, {
        stdout: () => { throw new Error("PRIVATE_MARKER", { cause: new Error(pem) }); },
        appendEnv: () => { appended = true; },
      });
    } catch (caught) { error = caught; }
    expect(appended).toBe(false);
    expect((error as Error).message).toBe("Publisher App private key preparation failed");
    expect((error as Error).cause).toBeUndefined();
  });

  it("rejects missing runner output without emitting a mask or key", () => {
    let writes = 0;
    expect(() => exportPublisherPrivateKey({ KCW_APP_PRIVATE_KEY: pem }, {
      stdout: () => { writes++; }, appendEnv: () => { writes++; },
    })).toThrow("Publisher App private key preparation failed");
    expect(writes).toBe(0);
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
describe("publisher key CLI and authority", () => {
  it("runs the actual CLI with no output except the escaped masking command and GITHUB_ENV", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kcw-key-env-"));
    const envFile = path.join(dir, "GITHUB_ENV");
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/agent-private-key.ts")], {
        cwd: root, encoding: "utf8", env: { ...process.env, KCW_APP_PRIVATE_KEY: forms["flattened-spaces"],
          GITHUB_ENV: envFile, TSX_TSCONFIG_PATH: path.join(root, "scripts/tsconfig.json") },
      });
      expect(result.status).toBe(0);
      expect(result.stderr.length === 0).toBe(true);
      expect(result.stdout.startsWith("::add-mask::")).toBe(true);
      expect(result.stdout.includes(pkcs8)).toBe(false);
      const exported = readFileSync(envFile, "utf8");
      expect(exported.includes(pkcs8)).toBe(true);
      expect(exported.startsWith("KCW_APP_PRIVATE_KEY<<KCW_PRIVATE_KEY_")).toBe(true);
    } finally {
      if (existsSync(envFile)) unlinkSync(envFile);
      rmdirSync(dir);
    }
  });

  it("the actual CLI redacts malformed input and emits no workflow commands", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/agent-private-key.ts")], {
      cwd: root, encoding: "utf8", env: { ...process.env, KCW_APP_PRIVATE_KEY: "PRIVATE_MARKER%0A::error::",
        GITHUB_ENV: "must-not-write", TSX_TSCONFIG_PATH: path.join(root, "scripts/tsconfig.json") },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Publisher App private key preparation failed");
  });

  it.each(["scripts/agent-private-key.ts", "scripts/lib/agent-private-key.ts"])("%s is already owner-critical", (file) => {
    const result = evaluate({ files: [{ path: file, status: "added" }], patches: {}, author: "test",
      planSummary: { format: 1, infra: [], artifact: { count: 0, kinds: { create: 0, update: 0, delete: 0, replace: 0 } } },
      lockDiff: { added: [], existing: [] },
    });
    expect(result.reasons).toContain(`trusted agent automation: ${file}`);
  });
});
