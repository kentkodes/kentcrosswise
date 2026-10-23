// Builds the orchestrator and relay bundles exactly as `pnpm build-lambdas` does (into a temp dir)
// and runs them in separate Node processes outside the repo, against a fake Secrets Manager / SQS
// HTTP endpoint (AWS_ENDPOINT_URL_*) and PGlite served over the wire protocol. Checks that each
// bundle loads, that the happy path works, and what happens when a secret is missing or empty.
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { servePglite, type PgSocketServer } from "../../agents/orchestrator/test/pg-socket";
import { BUNDLE_FILE, EXTERNALS, LAMBDA_TARGETS, bundleLambda, smokeImport, type BundleResult } from "../lib/lambda-bundle";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("Lambda targets match the infrastructure", () => {
  const lambdaTf = readFileSync(path.join(repoRoot, "infra/modules/orchestrator/lambda.tf"), "utf8");
  const prodTf = readFileSync(path.join(repoRoot, "infra/prod/main.tf"), "utf8");

  it.each(LAMBDA_TARGETS.map((t) => [t.name, t] as const))("%s: architecture and handler", (name, t) => {
    const block = new RegExp(`resource "aws_lambda_function" "${name}" \\{([\\s\\S]*?)\\n\\}`).exec(lambdaTf)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(new RegExp(`architectures\\s*=\\s*\\["${t.arch}"\\]`));
    expect(block).toMatch(/handler\s*=\s*"index\.handler"/);
    expect(BUNDLE_FILE).toBe("index.mjs");
  });

  it.each(LAMBDA_TARGETS.map((t) => [t.name, t] as const))("%s: infra/prod deploys the bundle directory", (name, t) => {
    const varName = name === "relay" ? "relay_package_dir" : "orchestrator_package_dir";
    const block = new RegExp(`variable "${varName}" \\{([\\s\\S]*?)\\n\\}`).exec(prodTf)?.[1];
    expect(block).toMatch(new RegExp(`default\\s*=\\s*"\\.\\./\\.\\./${t.outDir.replaceAll("/", "\\/")}"`));
  });
});

// ---------- fake AWS (Secrets Manager + SQS, JSON protocol) ----------

interface FakeAws {
  url: string;
  secrets: Map<string, string>;
  sent: { QueueUrl: string; MessageGroupId: string; MessageDeduplicationId: string; MessageBody: string }[];
  close(): Promise<void>;
}

async function startFakeAws(): Promise<FakeAws> {
  const secrets = new Map<string, string>();
  const sent: FakeAws["sent"] = [];
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/x-amz-json-1.1" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const target = String(req.headers["x-amz-target"] ?? "");
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, string>;
      if (target === "secretsmanager.GetSecretValue") {
        const value = secrets.get(input.SecretId!);
        if (value === undefined) {
          reply(res, 400, { __type: "ResourceNotFoundException", message: "no value for AWSCURRENT" });
        } else {
          reply(res, 200, { Name: input.SecretId, SecretString: value });
        }
        return;
      }
      if (target === "AmazonSQS.SendMessage") {
        sent.push(input as unknown as FakeAws["sent"][number]);
        const md5 = createHash("md5").update(input.MessageBody ?? "").digest("hex");
        reply(res, 200, { MessageId: `m-${sent.length}`, MD5OfMessageBody: md5 });
        return;
      }
      reply(res, 400, { __type: "UnknownOperationException", message: target });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secrets,
    sent,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------- running a bundle in its own process ----------

const RUNNER = [
  'import { pathToFileURL } from "node:url";',
  "const [bundle, event] = process.argv.slice(2);",
  "const m = await import(pathToFileURL(bundle).href);",
  "const r = await m.handler(JSON.parse(event));",
  'console.log("RESULT " + JSON.stringify(r));',
  "process.exit(0);",
].join("\n");

interface Invocation {
  result: unknown;
  /** Lines the function logged (stdout, without the RESULT line) and stderr. */
  logs: string[];
  output: string;
}

function invoke(dir: string, bundleFile: string, env: Record<string, string>, event: unknown): Promise<Invocation> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(dir, "run.mjs"), bundleFile, JSON.stringify(event)],
      {
        cwd: dir,
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "AKIDFAKEFAKEFAKE",
          AWS_SECRET_ACCESS_KEY: "fake-secret-access-key",
          AWS_EC2_METADATA_DISABLED: "true",
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
        const resultLine = lines.find((l) => l.startsWith("RESULT "));
        if (err || !resultLine) {
          reject(new Error(`bundle run failed: ${err?.message ?? "no result"}\n${stdout}\n${stderr}`));
          return;
        }
        resolve({
          result: JSON.parse(resultLine.slice("RESULT ".length)),
          logs: [...lines.filter((l) => l !== resultLine), ...stderr.split(/\r?\n/).filter((l) => l.length > 0)],
          output: stdout + stderr,
        });
      },
    );
  });
}

// ---------- the tests ----------

const WEBHOOK_SECRET = "synthetic-webhook-secret-0001";
const DB_MARKER = "synthetic-password-marker-0001";
const PUSH = readFileSync(path.join(repoRoot, "agents/webhook-relay/test/fixtures/push.json"), "utf8");
const SENDER_ID = (JSON.parse(PUSH) as { sender: { id: number } }).sender.id;

function signedPush(delivery: string, secret = WEBHOOK_SECRET) {
  return {
    requestContext: { http: { method: "POST" } },
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(PUSH).digest("hex")}`,
    },
    body: PUSH,
    isBase64Encoded: false,
  };
}

const sqsRecord = (id: string, body: unknown, taskId: number) => ({
  messageId: id,
  body: JSON.stringify(body),
  attributes: { MessageGroupId: `task-${taskId}` },
});

describe("built Lambda bundles", () => {
  const out = mkdtempSync(path.join(tmpdir(), "kcw-bundles-"));
  const bundles = new Map<string, BundleResult>();
  let aws: FakeAws;
  let db: PGlite;
  let orchDb: PgSocketServer;
  let relayDb: PgSocketServer;
  let relayPg: PGlite;

  beforeAll(async () => {
    for (const t of LAMBDA_TARGETS) bundles.set(t.name, await bundleLambda(repoRoot, t, path.join(out, t.name)));
    writeFileSync(path.join(out, "run.mjs"), RUNNER);
    aws = await startFakeAws();
    db = await PGlite.create();
    await migrate(fromPglite(db));
    orchDb = await servePglite(db, { role: "orch_rw" });
    relayPg = await PGlite.create();
    await migrate(fromPglite(relayPg));
    relayDb = await servePglite(relayPg);
  }, 180_000);

  afterAll(async () => {
    await aws?.close();
    await orchDb?.close();
    await relayDb?.close();
    await db?.close();
    await relayPg?.close();
    rmSync(out, { recursive: true, force: true });
  });

  const file = (name: string) => bundles.get(name)!.file;
  const setSecrets = (values: Record<string, unknown>) => {
    aws.secrets.clear();
    for (const [k, v] of Object.entries(values)) aws.secrets.set(k, typeof v === "string" ? v : JSON.stringify(v));
  };

  it("each bundle is plain JavaScript, loads outside the repo and exports handler", () => {
    for (const t of LAMBDA_TARGETS) {
      expect(smokeImport(file(t.name))).toEqual({ ok: true });
      const text = readFileSync(file(t.name), "utf8");
      // The optional pg modules stay external and are only reached lazily.
      for (const ext of EXTERNALS.slice(0, 2)) expect(text).toContain(`"${ext}"`);
    }
  });

  describe("relay", () => {
    const env = () => ({
      AWS_ENDPOINT_URL_SECRETS_MANAGER: aws.url,
      AWS_ENDPOINT_URL_SQS: aws.url,
      KCW_WEBHOOK_SECRET_NAME: "kcw/github/webhook-secret",
      KCW_RELAY_DB_SECRET_NAME: "kcw/prod/relay",
      KCW_ORCHESTRATOR_QUEUE_URL: `${aws.url}/000000000000/kcw-test-orchestrator-in.fifo`,
      KCW_RELAY_ALLOWED_SENDER_IDS: String(SENDER_ID),
    });

    it("forwards a signed delivery (Secrets Manager, Postgres and SQS through the bundled clients)", async () => {
      setSecrets({ "kcw/github/webhook-secret": { secret: WEBHOOK_SECRET }, "kcw/prod/relay": { db_url: relayDb.url } });
      const r = await invoke(out, file("relay"), env(), signedPush("bundle-ok-1"));
      expect(r.result).toMatchObject({ statusCode: 200, body: '{"result":"forwarded"}' });
      expect(aws.sent.at(-1)).toMatchObject({ MessageGroupId: "task-42", MessageDeduplicationId: "bundle-ok-1" });
    }, 60_000);

    it("an unsigned request is still a 401 first", async () => {
      setSecrets({ "kcw/github/webhook-secret": { secret: WEBHOOK_SECRET } });
      const r = await invoke(out, file("relay"), env(), signedPush("bundle-401", "wrong"));
      expect(r.result).toMatchObject({ statusCode: 401 });
    }, 60_000);

    it.each<[string, Record<string, unknown>, string]>([
      ["webhook secret has no value", {}, "relay: error (config) SecretNotFoundError"],
      ["webhook secret has no key", { "kcw/github/webhook-secret": {} }, "relay: error (config) SecretKeyMissingError"],
      ["webhook secret is empty", { "kcw/github/webhook-secret": { secret: "" } }, "relay: error (config) the webhook secret is empty"],
    ])("%s: 500 config", async (_label, secrets, line) => {
      setSecrets(secrets);
      const r = await invoke(out, file("relay"), env(), signedPush("bundle-cfg"));
      expect(r.result).toMatchObject({ statusCode: 500, body: '{"result":"error","reason":"config"}' });
      expect(r.logs).toEqual([line]);
    }, 60_000);

    it.each<[string, unknown, string]>([
      ["relay secret has no value", undefined, "SecretNotFoundError"],
      ["db_url is missing", { other: DB_MARKER }, "SecretKeyMissingError"],
      ["db_url is empty", { db_url: "" }, "ConfigError"],
    ])("%s: 500 db, nothing enqueued, no value logged", async (_label, relaySecret, errName) => {
      setSecrets({
        "kcw/github/webhook-secret": { secret: WEBHOOK_SECRET },
        ...(relaySecret === undefined ? {} : { "kcw/prod/relay": relaySecret }),
      });
      const before = aws.sent.length;
      const r = await invoke(out, file("relay"), env(), signedPush("bundle-db-1"));
      expect(r.result).toMatchObject({ statusCode: 500, body: '{"result":"error","reason":"db"}' });
      expect(r.logs).toEqual([`relay: error (db) event=push delivery=bundle-db-1 ${errName}`]);
      expect(aws.sent.length).toBe(before);
      expect(r.output).not.toContain(WEBHOOK_SECRET);
      expect(r.output).not.toContain(DB_MARKER);
    }, 60_000);
  });

  describe("orchestrator", () => {
    const env = () => ({
      AWS_ENDPOINT_URL_SECRETS_MANAGER: aws.url,
      KCW_ORCHESTRATOR_SECRET: "kcw/prod/orchestrator",
      KCW_MODELS_SECRET: "kcw/prod/models",
      LANGSMITH_TRACING: "true",
      LANGCHAIN_CALLBACKS_BACKGROUND: "false",
    });

    it("starts a thread on Postgres (bundled pg, checkpointer and graph); no LangSmith key turns tracing off", async () => {
      setSecrets({ "kcw/prod/orchestrator": { db_url: orchDb.url } });
      const r = await invoke(out, file("orchestrator"), env(), {
        Records: [sqsRecord("b1", { type: "task.created", task_id: 31 }, 31)],
      });
      expect(r.result).toEqual({ batchItemFailures: [] });
      expect(r.logs).toEqual(["langsmith_api_key missing (no secret value): tracing off", "message b1: started"]);
    }, 60_000);

    it.each<[string, unknown, string]>([
      ["orchestrator secret has no value", undefined, "SecretNotFoundError"],
      ["db_url is missing", { github_app_client_id: DB_MARKER }, "SecretKeyMissingError"],
      ["db_url is empty", { db_url: " " }, "ConfigError"],
    ])("%s: the batch goes back to the queue, no value logged", async (_label, orchSecret, errName) => {
      setSecrets({
        "kcw/prod/models": { langsmith_api_key: "" },
        ...(orchSecret === undefined ? {} : { "kcw/prod/orchestrator": orchSecret }),
      });
      const r = await invoke(out, file("orchestrator"), env(), {
        Records: [sqsRecord("e1", { type: "task.created", task_id: 32 }, 32), sqsRecord("e2", { type: "task.created", task_id: 33 }, 33)],
      });
      expect(r.result).toEqual({ batchItemFailures: [{ itemIdentifier: "e1" }, { itemIdentifier: "e2" }] });
      expect(r.logs).toEqual([
        "langsmith_api_key empty: tracing off",
        `init failed (${errName}): 2 message(s) returned to the queue`,
      ]);
      expect(r.output).not.toContain(DB_MARKER);
    }, 60_000);
  });
});
