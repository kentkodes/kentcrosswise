import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createAwsAdapters, type AwsAdapterClients } from "../lib/pipelines/aws";

function awsError(name: string): Error {
  const error = new Error(`${name} private-detail`);
  error.name = name;
  return error;
}

function fakeClients(s3Send: (command: unknown) => Promise<unknown>) {
  return {
    s3: { send: vi.fn(s3Send), destroy: vi.fn() },
    sqs: { send: vi.fn(async () => ({})), destroy: vi.fn() },
  };
}

const body = (text: string) => ({ async *[Symbol.asyncIterator]() { yield Buffer.from(text); }, destroy: vi.fn() });
const robotsRecord = JSON.stringify({ v: 1, fetchedAt: "2026-10-27T00:00:00.000Z", result: { kind: "response", status: 200, body: "User-agent: *\n" } });

describe("pipeline S3 metadata adapter", () => {
  const adapters = (clients: ReturnType<typeof fakeClients>) =>
    createAwsAdapters("private-meta", "https://sqs.example/q", "us-east-1", clients as unknown as AwsAdapterClients);

  it("AccessDenied on ListObjectsV2 propagates instead of reading as a cache miss", async () => {
    const c = fakeClients(async () => { throw awsError("AccessDenied"); });
    await expect(adapters(c).robots.get("https://example.org")).rejects.toThrow(/AccessDenied/);
    await expect(adapters(c).catalog.get("source-id")).rejects.toThrow(/AccessDenied/);
  });
  it("AccessDenied on GetObject after a positive listing propagates", async () => {
    const c = fakeClients(async (command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: command.input.Prefix }] };
      throw awsError("AccessDenied");
    });
    await expect(adapters(c).robots.get("https://example.org")).rejects.toThrow(/AccessDenied/);
  });
  it("an empty listing or a NoSuchKey race is a cache miss; listing is prefix-scoped", async () => {
    const empty = fakeClients(async () => ({ Contents: [] }));
    expect(await adapters(empty).robots.get("https://example.org")).toBeNull();
    const listed = vi.mocked(empty.s3.send).mock.calls[0]![0] as ListObjectsV2Command;
    expect(listed.input).toMatchObject({ Bucket: "private-meta", MaxKeys: 1 });
    expect(listed.input.Prefix).toMatch(/^pipelines\/meta\/robots\/[a-f0-9]{64}\/latest\.json$/);
    const raced = fakeClients(async (command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: command.input.Prefix }] };
      throw awsError("NoSuchKey");
    });
    expect(await adapters(raced).robots.get("https://example.org")).toBeNull();
  });
  it("reads a listed object", async () => {
    const c = fakeClients(async (command) => {
      if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: command.input.Prefix }] };
      if (command instanceof GetObjectCommand) return { Body: body(robotsRecord), ContentLength: robotsRecord.length };
      throw new Error("unexpected");
    });
    expect((await adapters(c).robots.get("https://example.org"))?.fetchedAt).toBe("2026-10-27T00:00:00.000Z");
  });
  it("close destroys both clients", () => {
    const c = fakeClients(async () => ({}));
    adapters(c).close();
    expect(c.s3.destroy).toHaveBeenCalledOnce();
    expect(c.sqs.destroy).toHaveBeenCalledOnce();
  });
});
