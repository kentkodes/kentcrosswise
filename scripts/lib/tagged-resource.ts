// Confirms whether a resource listed by the Resource Groups Tagging API still exists. The tagging
// index keeps deleted resources for minutes (Lambda event-source mappings for > 2.5 min, PRs #2 and
// #12), so check-preview-clean asks each service directly before calling an ARN a leftover.
// Fails closed: only a confirmed "not found" counts as gone; access denied, other errors and
// resource types without a check are "unconfirmed" (still a leftover, with the reason).
// Responses are only tested for existence; nothing from them is printed or kept.
import type { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import { DescribeFunctionCommand, GetDistributionCommand } from "@aws-sdk/client-cloudfront";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import type { IAMClient } from "@aws-sdk/client-iam";
import { GetRoleCommand } from "@aws-sdk/client-iam";
import type { LambdaClient } from "@aws-sdk/client-lambda";
import { GetEventSourceMappingCommand, GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import type { S3Client } from "@aws-sdk/client-s3";
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import type { SQSClient } from "@aws-sdk/client-sqs";
import { GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import type { SSMClient } from "@aws-sdk/client-ssm";
import { DescribeParametersCommand } from "@aws-sdk/client-ssm";

export type TaggedStatus = { state: "exists" } | { state: "gone" } | { state: "unconfirmed"; reason: string };

/** The SDK clients the check needs (only `send` is used, so tests pass fakes). */
export interface TaggedCheckClients {
  /** Region of the regional clients; ARNs in another region are not checked (unconfirmed). */
  region: string;
  lambda: Pick<LambdaClient, "send">;
  logs: Pick<CloudWatchLogsClient, "send">;
  sqs: Pick<SQSClient, "send">;
  cloudfront: Pick<CloudFrontClient, "send">;
  s3: Pick<S3Client, "send">;
  iam: Pick<IAMClient, "send">;
  ssm: Pick<SSMClient, "send">;
}

export interface ParsedArn {
  partition: string;
  service: string;
  region: string;
  account: string;
  resource: string;
}

export function parseArn(arn: string): ParsedArn | undefined {
  const parts = arn.split(":");
  if (parts.length < 6 || parts[0] !== "arn") return undefined;
  const [, partition, service, region, account, ...rest] = parts as [string, string, string, string, string, ...string[]];
  const resource = rest.join(":");
  if (!partition || !service || !resource) return undefined;
  return { partition, service, region, account, resource };
}

interface Check {
  /** API call name, for the reason text. */
  call: string;
  /** Error names that mean "does not exist". */
  notFound: readonly string[];
  /** Resolves true if it exists, false if the call proves it does not (e.g. an empty list). */
  run: () => Promise<boolean>;
}

const EXISTS: TaggedStatus = { state: "exists" };
const GONE: TaggedStatus = { state: "gone" };

function errorName(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : undefined;
}

function regional(arn: ParsedArn, c: TaggedCheckClients): string | undefined {
  return arn.region === c.region ? undefined : `region ${arn.region || "(none)"} is not checked`;
}

/** The check for an ARN, or the reason there is none. */
function checkFor(arn: ParsedArn, c: TaggedCheckClients): Check | string {
  const { service, resource } = arn;
  switch (service) {
    case "lambda": {
      const wrongRegion = regional(arn, c);
      if (wrongRegion) return wrongRegion;
      if (resource.startsWith("event-source-mapping:")) {
        const uuid = resource.slice("event-source-mapping:".length);
        return {
          call: "lambda:GetEventSourceMapping",
          notFound: ["ResourceNotFoundException"],
          run: async () => (await c.lambda.send(new GetEventSourceMappingCommand({ UUID: uuid })), true),
        };
      }
      if (resource.startsWith("function:")) {
        const name = resource.slice("function:".length).split(":")[0]!;
        return {
          call: "lambda:GetFunctionConfiguration",
          notFound: ["ResourceNotFoundException"],
          run: async () => (await c.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name })), true),
        };
      }
      break;
    }
    case "logs": {
      const wrongRegion = regional(arn, c);
      if (wrongRegion) return wrongRegion;
      if (resource.startsWith("log-group:")) {
        const name = resource.slice("log-group:".length).replace(/:\*$/, "");
        return {
          call: "logs:DescribeLogGroups",
          notFound: ["ResourceNotFoundException"],
          run: async () => {
            let nextToken: string | undefined;
            do {
              const page = await c.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name, nextToken }));
              if ((page.logGroups ?? []).some((g) => g.logGroupName === name)) return true;
              nextToken = page.nextToken;
            } while (nextToken);
            return false;
          },
        };
      }
      break;
    }
    case "sqs": {
      const wrongRegion = regional(arn, c);
      if (wrongRegion) return wrongRegion;
      if (!resource.includes("/") && !resource.includes(":")) {
        return {
          call: "sqs:GetQueueUrl",
          notFound: ["QueueDoesNotExist", "AWS.SimpleQueueService.NonExistentQueue"],
          run: async () => (
            await c.sqs.send(new GetQueueUrlCommand({ QueueName: resource, ...(arn.account && { QueueOwnerAWSAccountId: arn.account }) })),
            true
          ),
        };
      }
      break;
    }
    case "ssm": {
      const wrongRegion = regional(arn, c);
      if (wrongRegion) return wrongRegion;
      if (resource.startsWith("parameter/")) {
        // ARN arn:...:parameter/kcw/x is the parameter /kcw/x. DescribeParameters returns metadata
        // only, never the value.
        const name = resource.slice("parameter".length);
        return {
          call: "ssm:DescribeParameters",
          notFound: ["ParameterNotFound"],
          run: async () => {
            const res = await c.ssm.send(
              new DescribeParametersCommand({ ParameterFilters: [{ Key: "Name", Option: "Equals", Values: [name] }] }),
            );
            return (res.Parameters ?? []).some((p) => p.Name === name);
          },
        };
      }
      break;
    }
    case "cloudfront": {
      if (resource.startsWith("distribution/")) {
        const id = resource.slice("distribution/".length);
        return {
          call: "cloudfront:GetDistribution",
          notFound: ["NoSuchDistribution"],
          run: async () => (await c.cloudfront.send(new GetDistributionCommand({ Id: id })), true),
        };
      }
      if (resource.startsWith("function/")) {
        const name = resource.slice("function/".length);
        return {
          call: "cloudfront:DescribeFunction",
          notFound: ["NoSuchFunctionExists"],
          run: async () => (await c.cloudfront.send(new DescribeFunctionCommand({ Name: name })), true),
        };
      }
      break;
    }
    case "s3": {
      // Bucket ARNs have no region/account and no "/" (objects are not tagged resources here).
      if (!resource.includes("/")) {
        return {
          call: "s3:HeadBucket",
          notFound: ["NotFound", "NoSuchBucket"],
          run: async () => (await c.s3.send(new HeadBucketCommand({ Bucket: resource })), true),
        };
      }
      break;
    }
    case "iam": {
      if (resource.startsWith("role/")) {
        const name = resource.split("/").pop()!;
        return {
          call: "iam:GetRole",
          notFound: ["NoSuchEntityException", "NoSuchEntity"],
          run: async () => (await c.iam.send(new GetRoleCommand({ RoleName: name })), true),
        };
      }
      break;
    }
  }
  return `no existence check for ${service} resource type`;
}

/** Asks the owning service whether a tagged ARN still exists. Never throws. */
export async function checkTaggedResource(arn: string, c: TaggedCheckClients): Promise<TaggedStatus> {
  const parsed = parseArn(arn);
  if (!parsed) return { state: "unconfirmed", reason: "not an ARN" };
  const check = checkFor(parsed, c);
  if (typeof check === "string") return { state: "unconfirmed", reason: check };
  try {
    return (await check.run()) ? EXISTS : GONE;
  } catch (err) {
    const name = errorName(err) ?? "error";
    if (check.notFound.includes(name)) return GONE;
    return { state: "unconfirmed", reason: `${check.call} failed: ${name}` };
  }
}
