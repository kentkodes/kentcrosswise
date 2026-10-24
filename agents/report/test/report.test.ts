import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, QUEUE_URL_ENV, UsageError, runCli, sendReport, usageFromExecution, type SqsLike } from "../src/index";

const QUEUE = "https://sqs.us-east-1.amazonaws.com/000000000000/orchestrator-in.fifo";

/** Records every SendMessage input; optionally fails. */
class FakeSqs implements SqsLike {
  readonly sent: SendMessageCommand["input"][] = [];
  constructor(private readonly fail?: Error) {}
  async send(command: SendMessageCommand): Promise<unknown> {
    if (this.fail) throw this.fail;
    this.sent.push(command.input);
    return { MessageId: `m-${this.sent.length}` };
  }
}

function cli(argv: string[], opts: { env?: Record<string, string>; sqs?: FakeSqs } = {}) {
  const out: string[] = [];
  const sqs = opts.sqs ?? new FakeSqs();
  const run = runCli(argv, { env: opts.env ?? {}, sqs, stdout: (l) => out.push(l) });
  return { run, out, sqs };
}

const BASE = ["--task-id", "42", "--agent", "developer", "--event-type", "pr_opened"];

describe("@kcw/report", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/report");
  });
});

describe("sendReport", () => {
  it("sends the report as JSON, grouped by the task's thread", async () => {
    const sqs = new FakeSqs();
    const id = await sendReport(
      { task_id: 7, agent: "qa", event_type: "approved" },
      { sqs, queueUrl: QUEUE, dedupeId: "run-1-qa" },
    );
    expect(id).toBe("m-1");
    expect(sqs.sent).toEqual([
      {
        QueueUrl: QUEUE,
        MessageBody: JSON.stringify({ task_id: 7, agent: "qa", event_type: "approved" }),
        MessageGroupId: "task-7",
        MessageDeduplicationId: "run-1-qa",
      },
    ]);
  });

  it("uses a fresh deduplication id by default", async () => {
    const sqs = new FakeSqs();
    const r = { task_id: 1, agent: "developer", event_type: "coding" } as const;
    await sendReport(r, { sqs, queueUrl: QUEUE });
    await sendReport(r, { sqs, queueUrl: QUEUE });
    const ids = sqs.sent.map((m) => m.MessageDeduplicationId);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("refuses an invalid report before calling SQS", async () => {
    const sqs = new FakeSqs();
    await expect(
      sendReport({ task_id: 1, agent: "developer", event_type: "nope" as "coding" }, { sqs, queueUrl: QUEUE }),
    ).rejects.toThrow(/event_type/);
    expect(sqs.sent).toEqual([]);
  });
});

describe("kcw-report CLI", () => {
  it("sends {task_id, agent, event_type} to the queue from the environment", async () => {
    const c = cli(BASE, { env: { [QUEUE_URL_ENV]: QUEUE } });
    await c.run;
    expect(c.sqs.sent).toHaveLength(1);
    expect(c.sqs.sent[0]).toMatchObject({ QueueUrl: QUEUE, MessageGroupId: "task-42" });
    expect(JSON.parse(c.sqs.sent[0]!.MessageBody!)).toEqual({ task_id: 42, agent: "developer", event_type: "pr_opened" });
    expect(c.out).toEqual(["kcw-report: sent pr_opened from developer for task-42 (message m-1)"]);
  });

  it("includes model and Actions usage", async () => {
    const c = cli(
      [
        ...BASE,
        "--provider", "anthropic",
        "--model", "claude-haiku-5-5",
        "--input-tokens", "1200",
        "--output-tokens", "300",
        "--minutes", "4.5",
        "--queue-url", QUEUE,
        "--dedupe-id", "run-9",
      ],
    );
    await c.run;
    expect(c.sqs.sent[0]!.MessageDeduplicationId).toBe("run-9");
    expect(JSON.parse(c.sqs.sent[0]!.MessageBody!)).toEqual({
      task_id: 42,
      agent: "developer",
      event_type: "pr_opened",
      usage: [
        { kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 1200, output_tokens: 300 },
        { kind: "actions_minutes", minutes: 4.5 },
      ],
    });
  });

  it("sends a usage-only report without --event-type", async () => {
    const c = cli([
      "--task-id", "42", "--agent", "qa",
      "--provider", "anthropic", "--model", "claude-haiku-5-5", "--input-tokens", "10", "--output-tokens", "2",
      "--queue-url", QUEUE,
    ]);
    await c.run;
    expect(JSON.parse(c.sqs.sent[0]!.MessageBody!)).toEqual({
      task_id: 42,
      agent: "qa",
      usage: [{ kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 10, output_tokens: 2 }],
    });
    expect(c.out).toEqual(["kcw-report: sent usage from qa for task-42 (message m-1)"]);
  });

  it("--queue-url wins over the environment", async () => {
    const c = cli([...BASE, "--queue-url", QUEUE], { env: { [QUEUE_URL_ENV]: "https://other.invalid/q" } });
    await c.run;
    expect(c.sqs.sent[0]!.QueueUrl).toBe(QUEUE);
  });

  it("dry run prints the message JSON and sends nothing (no queue URL needed)", async () => {
    const c = cli([...BASE, "--minutes", "2", "--dry-run"]);
    await c.run;
    expect(c.sqs.sent).toEqual([]);
    expect(c.out).toHaveLength(1);
    expect(JSON.parse(c.out[0]!)).toEqual({
      task_id: 42,
      agent: "developer",
      event_type: "pr_opened",
      usage: [{ kind: "actions_minutes", minutes: 2 }],
    });
  });

  it("prints help", async () => {
    const c = cli(["--help"]);
    await c.run;
    expect(c.out[0]).toMatch(/^Usage: pnpm kcw-report/);
  });

  it.each([
    [["--agent", "developer", "--event-type", "coding"], /required/],
    [["--task-id", "1", "--agent", "developer"], /--event-type is required unless the report carries usage/],
    [["--task-id", "0", "--agent", "developer", "--event-type", "coding"], /task_id/],
    [["--task-id", "4x", "--agent", "developer", "--event-type", "coding"], /--task-id/],
    [["--task-id", "1", "--agent", "intern", "--event-type", "coding"], /agent must be one of/],
    [["--task-id", "1", "--agent", "qa", "--event-type", "exploded"], /event_type must be one of/],
    [[...BASE, "--model", "claude-haiku-5-5"], /model usage needs all/],
    [[...BASE, "--provider", "a", "--model", "m", "--input-tokens", "-1", "--output-tokens", "2"], /option|--input-tokens/],
    [[...BASE, "--minutes", "lots"], /--minutes/],
    [[...BASE, "--bogus"], /unknown or malformed option/],
  ])("rejects bad input %j", async (argv, msg) => {
    const c = cli([...argv, "--queue-url", QUEUE]);
    await expect(c.run).rejects.toThrow(msg);
    expect(c.sqs.sent).toEqual([]);
  });

  it("needs a queue URL unless it is a dry run", async () => {
    const c = cli(BASE);
    await expect(c.run).rejects.toBeInstanceOf(UsageError);
    await expect(cli(BASE).run).rejects.toThrow(new RegExp(QUEUE_URL_ENV));
  });

  it("reports an SQS failure by error name only", async () => {
    const err = Object.assign(new Error("long SDK message with request details"), { name: "QueueDoesNotExist" });
    const c = cli([...BASE, "--queue-url", QUEUE], { sqs: new FakeSqs(err) });
    await expect(c.run).rejects.toThrow("could not send the report to SQS (QueueDoesNotExist)");
  });
});

describe("--claude-execution-file", () => {
  const EXEC = [
    { type: "system", subtype: "init", model: "claude-haiku-5-5" },
    { type: "assistant", message: { content: "tool output that must never be echoed" } },
    {
      type: "result",
      subtype: "success",
      modelUsage: {
        "claude-haiku-5-5": { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 },
        "claude-other-model": { inputTokens: 0, outputTokens: 0 },
      },
    },
  ];
  const FILES: Record<string, string> = { "/x/exec.json": JSON.stringify(EXEC), "/x/bad.json": "{not json", "/x/obj.json": "{}" };

  function run(file: string) {
    const sqs = new FakeSqs();
    const p = runCli([...BASE, "--queue-url", QUEUE, "--claude-execution-file", file], {
      env: {},
      sqs,
      stdout: () => {},
      readFile: async (path) => {
        const v = FILES[path];
        if (v === undefined) throw new Error("ENOENT");
        return v;
      },
    });
    return { p, sqs };
  }

  it("adds one model usage line per model with tokens (cache counted as input)", async () => {
    const r = run("/x/exec.json");
    await r.p;
    expect(JSON.parse(r.sqs.sent[0]!.MessageBody!)).toEqual({
      task_id: 42,
      agent: "developer",
      event_type: "pr_opened",
      usage: [{ kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 1110, output_tokens: 50 }],
    });
  });

  it("sends the event without usage when the file does not exist (Claude never ran)", async () => {
    const r = run("/x/missing.json");
    await r.p;
    expect(JSON.parse(r.sqs.sent[0]!.MessageBody!)).toEqual({ task_id: 42, agent: "developer", event_type: "pr_opened" });
  });

  it("sends usage-only from the file without --event-type, and rejects a usage-only report with no usage", async () => {
    const files: Record<string, string> = { "/x/exec.json": JSON.stringify(EXEC) };
    const go = (file: string) => {
      const sqs = new FakeSqs();
      const p = runCli(["--task-id", "42", "--agent", "developer", "--queue-url", QUEUE, "--claude-execution-file", file], {
        env: {}, sqs, stdout: () => {},
        readFile: async (path) => { const v = files[path]; if (v === undefined) throw new Error("ENOENT"); return v; },
      });
      return { p, sqs };
    };
    const ok = go("/x/exec.json");
    await ok.p;
    expect(JSON.parse(ok.sqs.sent[0]!.MessageBody!)).toEqual({
      task_id: 42,
      agent: "developer",
      usage: [{ kind: "model", provider: "anthropic", model: "claude-haiku-5-5", input_tokens: 1110, output_tokens: 50 }],
    });
    const empty = go("/x/missing.json");
    await expect(empty.p).rejects.toBeInstanceOf(UsageError);
    expect(empty.sqs.sent).toEqual([]);
  });

  it("ignores an empty path (output of a skipped Claude step)", async () => {
    const r = run("");
    await r.p;
    expect(r.sqs.sent).toHaveLength(1);
  });

  it.each(["/x/bad.json", "/x/obj.json"])("rejects a malformed file %s without quoting it", async (file) => {
    const r = run(file);
    await expect(r.p).rejects.toBeInstanceOf(UsageError);
    await expect(r.p).rejects.not.toThrow(/not json/);
    expect(r.sqs.sent).toEqual([]);
  });

  it("finds no usage without a result message", () => {
    expect(usageFromExecution([{ type: "system" }])).toEqual([]);
  });
});
