import { describe, expect, it } from "vitest";
import { checkTaggedResource, parseArn, type TaggedCheckClients } from "../lib/tagged-resource";

type Reply = unknown | Error;
type Handler = (command: string, input: Record<string, unknown>) => Reply;

interface Call {
  client: string;
  command: string;
  input: Record<string, unknown>;
}

function awsError(name: string): Error {
  return Object.assign(new Error(`synthetic ${name}`), { name });
}

/** Fake SDK clients: every send() is recorded and answered by `handler` (an Error is thrown). */
function fakeClients(handler: Handler, region = "us-east-1"): { clients: TaggedCheckClients; calls: Call[] } {
  const calls: Call[] = [];
  const client = (name: string) => ({
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const command = cmd.constructor.name;
      calls.push({ client: name, command, input: cmd.input });
      const reply = handler(command, cmd.input);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  const clients = {
    region,
    lambda: client("lambda"),
    logs: client("logs"),
    sqs: client("sqs"),
    cloudfront: client("cloudfront"),
    s3: client("s3"),
    iam: client("iam"),
    ssm: client("ssm"),
  } as unknown as TaggedCheckClients;
  return { clients, calls };
}

const ACCOUNT = "000000000000";

// One row per resource type the preview creates: ARN, expected client/command/input, not-found error.
const CASES = [
  {
    arn: `arn:aws:lambda:us-east-1:${ACCOUNT}:event-source-mapping:5d886b80-70fc-4acc-9132-b7ec8c02daef`,
    client: "lambda",
    command: "GetEventSourceMappingCommand",
    input: { UUID: "5d886b80-70fc-4acc-9132-b7ec8c02daef" },
    notFound: "ResourceNotFoundException",
  },
  {
    arn: `arn:aws:lambda:us-east-1:${ACCOUNT}:function:kcw-pr-7-server`,
    client: "lambda",
    command: "GetFunctionConfigurationCommand",
    input: { FunctionName: "kcw-pr-7-server" },
    notFound: "ResourceNotFoundException",
  },
  {
    arn: `arn:aws:sqs:us-east-1:${ACCOUNT}:kcw-pr-7-revalidation.fifo`,
    client: "sqs",
    command: "GetQueueUrlCommand",
    input: { QueueName: "kcw-pr-7-revalidation.fifo", QueueOwnerAWSAccountId: ACCOUNT },
    notFound: "QueueDoesNotExist",
  },
  {
    arn: `arn:aws:sqs:us-east-1:${ACCOUNT}:kcw-pr-7-revalidation.fifo`,
    client: "sqs",
    command: "GetQueueUrlCommand",
    input: { QueueName: "kcw-pr-7-revalidation.fifo", QueueOwnerAWSAccountId: ACCOUNT },
    notFound: "AWS.SimpleQueueService.NonExistentQueue",
  },
  {
    arn: `arn:aws:cloudfront::${ACCOUNT}:distribution/E2EXAMPLE`,
    client: "cloudfront",
    command: "GetDistributionCommand",
    input: { Id: "E2EXAMPLE" },
    notFound: "NoSuchDistribution",
  },
  {
    arn: `arn:aws:cloudfront::${ACCOUNT}:function/kcw-pr-7-forward-host`,
    client: "cloudfront",
    command: "DescribeFunctionCommand",
    input: { Name: "kcw-pr-7-forward-host" },
    notFound: "NoSuchFunctionExists",
  },
  {
    arn: `arn:aws:s3:::kcw-pr-7-assets-${ACCOUNT}`,
    client: "s3",
    command: "HeadBucketCommand",
    input: { Bucket: `kcw-pr-7-assets-${ACCOUNT}` },
    notFound: "NotFound",
  },
  {
    arn: `arn:aws:iam::${ACCOUNT}:role/kcw-pr-7-image`,
    client: "iam",
    command: "GetRoleCommand",
    input: { RoleName: "kcw-pr-7-image" },
    notFound: "NoSuchEntityException",
  },
] as const;

describe("parseArn", () => {
  it("splits an ARN and keeps colons inside the resource", () => {
    expect(parseArn("arn:aws:logs:us-east-1:1:log-group:/aws/lambda/x:*")).toEqual({
      partition: "aws",
      service: "logs",
      region: "us-east-1",
      account: "1",
      resource: "log-group:/aws/lambda/x:*",
    });
    expect(parseArn("not-an-arn")).toBeUndefined();
    expect(parseArn("arn:aws:s3:::")).toBeUndefined();
  });
});

describe("checkTaggedResource", () => {
  for (const c of CASES) {
    it(`${c.command}: exists, confirmed gone (${c.notFound}), or unconfirmed on access denied`, async () => {
      const exists = fakeClients(() => ({}));
      expect(await checkTaggedResource(c.arn, exists.clients)).toEqual({ state: "exists" });
      expect(exists.calls).toEqual([{ client: c.client, command: c.command, input: c.input }]);

      const gone = fakeClients(() => awsError(c.notFound));
      expect(await checkTaggedResource(c.arn, gone.clients)).toEqual({ state: "gone" });

      const denied = fakeClients(() => awsError("AccessDeniedException"));
      const status = await checkTaggedResource(c.arn, denied.clients);
      expect(status).toEqual({ state: "unconfirmed", reason: expect.stringMatching(/failed: AccessDeniedException$/) });
    });
  }

  it("does not take another service's not-found as gone", async () => {
    const { clients } = fakeClients(() => awsError("NoSuchEntityException"));
    expect(await checkTaggedResource(`arn:aws:lambda:us-east-1:${ACCOUNT}:function:kcw-pr-7-server`, clients)).toEqual({
      state: "unconfirmed",
      reason: "lambda:GetFunctionConfiguration failed: NoSuchEntityException",
    });
  });

  it("finds a log group by exact name across pages", async () => {
    const name = "/aws/lambda/kcw-pr-7-server";
    const arn = `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${name}:*`;
    const pages: Record<string, unknown> = {
      first: { logGroups: [{ logGroupName: `${name}-other` }], nextToken: "t2" },
      t2: { logGroups: [{ logGroupName: name }] },
    };
    const found = fakeClients((_cmd, input) => pages[(input.nextToken as string | undefined) ?? "first"]);
    expect(await checkTaggedResource(arn, found.clients)).toEqual({ state: "exists" });
    expect(found.calls.map((c) => [c.command, c.input])).toEqual([
      ["DescribeLogGroupsCommand", { logGroupNamePrefix: name, nextToken: undefined }],
      ["DescribeLogGroupsCommand", { logGroupNamePrefix: name, nextToken: "t2" }],
    ]);

    const onlyPrefixMatches = fakeClients(() => ({ logGroups: [{ logGroupName: `${name}-other` }] }));
    expect(await checkTaggedResource(arn, onlyPrefixMatches.clients)).toEqual({ state: "gone" });

    const denied = fakeClients(() => awsError("AccessDeniedException"));
    expect(await checkTaggedResource(arn, denied.clients)).toEqual({
      state: "unconfirmed",
      reason: "logs:DescribeLogGroups failed: AccessDeniedException",
    });
  });

  it("checks an SSM parameter by name with DescribeParameters (metadata only)", async () => {
    const arn = `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/kcw/preview/pr-7/database-url`;
    const exists = fakeClients(() => ({ Parameters: [{ Name: "/kcw/preview/pr-7/database-url" }] }));
    expect(await checkTaggedResource(arn, exists.clients)).toEqual({ state: "exists" });
    expect(exists.calls).toEqual([
      {
        client: "ssm",
        command: "DescribeParametersCommand",
        input: { ParameterFilters: [{ Key: "Name", Option: "Equals", Values: ["/kcw/preview/pr-7/database-url"] }] },
      },
    ]);
    const gone = fakeClients(() => ({ Parameters: [] }));
    expect(await checkTaggedResource(arn, gone.clients)).toEqual({ state: "gone" });
  });

  it("uses the last path segment of a role with a path", async () => {
    const { clients, calls } = fakeClients(() => ({}));
    await checkTaggedResource(`arn:aws:iam::${ACCOUNT}:role/service/kcw-pr-7-x`, clients);
    expect(calls[0]?.input).toEqual({ RoleName: "kcw-pr-7-x" });
  });

  it("fails closed for unknown types, other regions and non-ARNs without calling AWS", async () => {
    const { clients, calls } = fakeClients(() => ({}));
    expect(await checkTaggedResource(`arn:aws:dynamodb:us-east-1:${ACCOUNT}:table/kcw-pr-7`, clients)).toEqual({
      state: "unconfirmed",
      reason: "no existence check for dynamodb resource type",
    });
    expect(await checkTaggedResource(`arn:aws:lambda:us-east-1:${ACCOUNT}:layer:kcw-pr-7:1`, clients)).toEqual({
      state: "unconfirmed",
      reason: "no existence check for lambda resource type",
    });
    expect(await checkTaggedResource(`arn:aws:s3:::kcw-pr-7-assets/key`, clients)).toEqual({
      state: "unconfirmed",
      reason: "no existence check for s3 resource type",
    });
    expect(await checkTaggedResource(`arn:aws:lambda:eu-west-1:${ACCOUNT}:function:kcw-pr-7-server`, clients)).toEqual({
      state: "unconfirmed",
      reason: "region eu-west-1 is not checked",
    });
    expect(await checkTaggedResource("kcw-pr-7-server", clients)).toEqual({ state: "unconfirmed", reason: "not an ARN" });
    expect(calls).toEqual([]);
  });

  it("reports a thrown non-error value as unconfirmed", async () => {
    const { clients } = fakeClients(() => {
      throw "weird";
    });
    expect(await checkTaggedResource(`arn:aws:cloudfront::${ACCOUNT}:distribution/E1`, clients)).toEqual({
      state: "unconfirmed",
      reason: "cloudfront:GetDistribution failed: error",
    });
  });
});
