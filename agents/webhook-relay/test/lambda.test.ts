import { PGlite } from "@electric-sql/pglite";
import { fromPglite, migrate } from "@kcw/db";
import { createFakeSecrets } from "@kcw/secrets";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, ENV, configFromEnv, createHandler, type FunctionUrlEvent, type HandlerOptions } from "../src/lambda";
import { signBody } from "../src/index";
import { DELIVERY, FakeSqs, IDS, SECRET, awsError, fixture } from "./helpers";

const QUEUE = "https://sqs.us-east-1.amazonaws.com/000000000000/orchestrator-in.fifo";
const ENVS = {
  [ENV.dbSecretName]: "kcw/test/relay",
  [ENV.queueUrl]: QUEUE,
  [ENV.allowedSenderIds]: `${IDS.owner}, ${IDS.developer},${IDS.qa}`,
};

function urlEvent(event: string, payload: unknown, opts: { base64?: boolean; delivery?: string } = {}): FunctionUrlEvent {
  const raw = JSON.stringify(payload);
  return {
    requestContext: { http: { method: "POST" } },
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": opts.delivery ?? DELIVERY,
      "x-hub-signature-256": signBody(raw, SECRET),
    },
    body: opts.base64 ? Buffer.from(raw).toString("base64") : raw,
    isBase64Encoded: opts.base64 === true,
  };
}

describe("configFromEnv", () => {
  it("reads names, queue URL and sender ids", () => {
    const c = configFromEnv(ENVS);
    expect(c).toMatchObject({
      webhookSecretName: "kcw/github/webhook-secret",
      dbSecretName: "kcw/test/relay",
      queueUrl: QUEUE,
      region: "us-east-1",
    });
    expect([...c.allowedSenderIds]).toEqual([IDS.owner, IDS.developer, IDS.qa]);
  });

  it.each<[string, Record<string, string>]>([
    ["no allowlist", { [ENV.allowedSenderIds]: "" }],
    ["allowlist of logins", { [ENV.allowedSenderIds]: "kcw-qa[bot]" }],
    ["allowlist with junk", { [ENV.allowedSenderIds]: "1,two" }],
    ["no queue", { [ENV.queueUrl]: " " }],
    ["no db secret", { [ENV.dbSecretName]: "" }],
  ])("fails closed: %s", (_label, over) => {
    expect(() => configFromEnv({ ...ENVS, ...over })).toThrow(ConfigError);
  });
});

describe("Lambda handler (Function URL v2) with fake secrets, fake SQS and PGlite", () => {
  let pg: PGlite;
  const opened: number[] = [];

  beforeAll(async () => {
    pg = new PGlite();
    await migrate(fromPglite(pg));
    await pg.exec("INSERT INTO tasks (source, owner_text, pr_number) VALUES ('console', 'synthetic', 12)");
  });
  afterAll(async () => {
    await pg.close();
  });

  function make({ secrets: initial, ...over }: Omit<Partial<HandlerOptions>, "secrets"> & { secrets?: Record<string, unknown> } = {}) {
    const { store, aws } = createFakeSecrets(
      (initial ?? {
        "kcw/github/webhook-secret": { secret: SECRET },
        "kcw/test/relay": { db_url: "postgres://synthetic.invalid/db" },
      }) as Record<string, Record<string, string>>,
    );
    const sqs = new FakeSqs();
    const logs: string[] = [];
    const handler = createHandler({
      env: ENVS,
      secrets: store,
      sqs,
      openDb: async (url) => {
        expect(url).toBe("postgres://synthetic.invalid/db");
        opened.push(1);
        return { db: fromPglite(pg), close: async () => {} };
      },
      log: (l) => logs.push(l),
      ...over,
    });
    return { handler, sqs, aws, logs };
  }

  it("forwards a PR event to the FIFO queue grouped by thread, deduped by delivery id", async () => {
    const t = make();
    const p = fixture("pull_request.opened");
    p.pull_request.head.ref = "owner-hotfix"; // resolve through the DB: PR 12 -> task 1
    const r = await t.handler(urlEvent("pull_request", p));
    expect(r).toEqual({ statusCode: 200, headers: { "content-type": "application/json" }, body: '{"result":"forwarded"}' });
    expect(t.sqs.sent).toHaveLength(1);
    const input = t.sqs.sent[0]!;
    expect(input).toMatchObject({ QueueUrl: QUEUE, MessageGroupId: "task-1", MessageDeduplicationId: DELIVERY });
    expect(JSON.parse(input.MessageBody!)).toMatchObject({
      source: "github",
      thread_id: "task-1",
      task_id: 1,
      resume: { event: "pull_request.opened", head_sha: "1111111111111111111111111111111111111111" },
    });
    // Second delivery of the same id: inbound_events says duplicate.
    expect(JSON.parse((await t.handler(urlEvent("pull_request", p))).body)).toEqual({ result: "duplicate" });
    expect(t.sqs.sent).toHaveLength(1);
  });

  it("accepts a base64-encoded body", async () => {
    const t = make();
    const r = await t.handler(urlEvent("push", fixture("push"), { base64: true, delivery: "b64-1" }));
    expect(JSON.parse(r.body)).toEqual({ result: "forwarded" });
    expect(t.sqs.sent[0]).toMatchObject({ MessageGroupId: "task-42" });
  });

  it("reads the webhook secret once per process", async () => {
    const t = make();
    await t.handler(urlEvent("push", fixture("push"), { delivery: "cache-1" }));
    await t.handler(urlEvent("push", fixture("push"), { delivery: "cache-2" }));
    expect(t.aws.calls.filter((c) => c.name === "kcw/github/webhook-secret")).toHaveLength(1);
  });

  it("does not open the database for ignored deliveries", async () => {
    const t = make();
    const before = opened.length;
    const p = fixture("push");
    p.sender.id = IDS.stranger;
    expect(JSON.parse((await t.handler(urlEvent("push", p))).body)).toEqual({ result: "ignored", reason: "sender" });
    expect(opened.length).toBe(before);
  });

  it("an invalid signature is a 401", async () => {
    const t = make();
    const e = urlEvent("push", fixture("push"));
    e.headers!["x-hub-signature-256"] = signBody("x", "wrong");
    expect((await t.handler(e)).statusCode).toBe(401);
    expect(t.sqs.sent).toEqual([]);
  });

  it("a queue failure is a 502 and the delivery can be retried", async () => {
    const t = make();
    t.sqs.failWith = awsError("AccessDenied");
    const e = urlEvent("push", fixture("push"), { delivery: "retry-1" });
    expect((await t.handler(e)).statusCode).toBe(502);
    t.sqs.failWith = undefined;
    expect(JSON.parse((await t.handler(e)).body)).toEqual({ result: "forwarded" });
  });

  it("missing configuration or webhook secret is a 500 that logs no values", async () => {
    const noEnv = make({ env: {} });
    expect((await noEnv.handler(urlEvent("push", fixture("push")))).statusCode).toBe(500);
    expect(noEnv.logs.join("\n")).toMatch(/KCW_RELAY_ALLOWED_SENDER_IDS|KCW_RELAY_DB_SECRET_NAME|KCW_ORCHESTRATOR_QUEUE_URL/);

    const noSecret = make({ secrets: {} });
    const r = await noSecret.handler(urlEvent("push", fixture("push")));
    expect(r).toMatchObject({ statusCode: 500, body: '{"result":"error","reason":"config"}' });
    expect(noSecret.logs).toEqual(["relay: error (config) SecretNotFoundError"]);
  });

  it("a missing db_url is a 500 (db) and nothing is sent", async () => {
    const t = make({ secrets: { "kcw/github/webhook-secret": { secret: SECRET }, "kcw/test/relay": { other: "x" } } });
    const r = await t.handler(urlEvent("push", fixture("push"), { delivery: "nodb-1" }));
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ result: "error", reason: "db" });
    expect(t.sqs.sent).toEqual([]);
  });

  it("an empty db_url is a 500 (db) without connecting, and is re-read once filled", async () => {
    const t = make({ secrets: { "kcw/github/webhook-secret": { secret: SECRET }, "kcw/test/relay": { db_url: " " } } });
    const before = opened.length;
    const e = urlEvent("push", fixture("push"), { delivery: "emptydb-1" });
    const r = await t.handler(e);
    expect(r).toMatchObject({ statusCode: 500, body: '{"result":"error","reason":"db"}' });
    expect(opened.length).toBe(before);
    expect(t.sqs.sent).toEqual([]);
    expect(t.logs).toEqual(["relay: error (db) event=push delivery=emptydb-1 ConfigError"]);

    // The owner fills the secret: the next delivery reads it again (no cold start needed).
    t.aws.values.set("kcw/test/relay", JSON.stringify({ db_url: "postgres://synthetic.invalid/db" }));
    expect(JSON.parse((await t.handler(e)).body)).toEqual({ result: "forwarded" });
  });
});
