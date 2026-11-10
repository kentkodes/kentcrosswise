import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createDiscoveryPublisher } from "../../../packages/essays/src/discovery/event";
import { createMetadataStores } from "./metadata";

/** Consume or destroy every response stream, including over-limit responses. */
export async function readMetadataBody(body: AsyncIterable<Uint8Array> & { destroy?: () => void }, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("metadata_object_too_large");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { body.destroy?.(); }
}

/**
 * Writes essay text objects for the ingest job (its role has PutObject on `essays/text/*` only).
 * The key is a content hash, so a conditional put (`If-None-Match: *`) that finds the key already
 * there (412) is success: the identical bytes are stored. Nothing is read back or listed.
 */
export function createTextObjectWriter(bucket: string, region: string, client?: Pick<S3Client, "send" | "destroy">) {
  const s3 = client ?? new S3Client({ region });
  return {
    async putObject(key: string, body: Uint8Array): Promise<void> {
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "text/plain; charset=utf-8", IfNoneMatch: "*" }));
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 412) throw error;
      }
    },
    close() { s3.destroy(); },
  };
}

/** The SDK clients the adapters use (only `send`/`destroy`, so tests pass fakes). */
export interface AwsAdapterClients {
  s3: Pick<S3Client, "send" | "destroy">;
  sqs: Pick<SQSClient, "send" | "destroy">;
}

/** Called only after activation, input validation, and pause guards. No top-level AWS clients. */
export function createAwsAdapters(bucket: string, queueUrl: string, region: string, clients?: AwsAdapterClients) {
  const { s3, sqs } = clients ?? { s3: new S3Client({ region }), sqs: new SQSClient({ region }) };
  const stores = createMetadataStores({
    async read(key, maxBytes) {
      try {
        // A missing object is a 403 (not 404) for GetObject without ListBucket. An explicit
        // prefix-scoped listing proves a cache miss without interpreting AccessDenied as absence.
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 }));
        if (listed.Contents?.[0]?.Key !== key) return null;
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!result.Body) throw new Error("metadata_object_empty");
        if ((result.ContentLength ?? 0) > maxBytes) {
          (result.Body as { destroy?: () => void }).destroy?.();
          throw new Error("metadata_object_too_large");
        }
        return await readMetadataBody(result.Body as AsyncIterable<Uint8Array> & { destroy?: () => void }, maxBytes);
      } catch (error) {
        // Only a not-found after a positive listing (deleted in between) is a miss; AccessDenied and
        // every other error propagate, so a permissions fault never looks like an empty cache.
        if (error instanceof Error && error.name === "NoSuchKey") return null;
        throw error;
      }
    },
    async write(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
  });
  return {
    ...stores,
    publish: createDiscoveryPublisher({ send: (input) => sqs.send(new SendMessageCommand(input)) }, queueUrl),
    close() { s3.destroy(); sqs.destroy(); },
  };
}
