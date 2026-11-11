// Full essay text (essays reader). Text objects sit in the private pipelines bucket under
// essays/text/<sha256>.txt, written by the essay-ingest job. The web server role may only
// s3:GetObject on that prefix (infra/modules/web, prod only, from ESSAY_TEXT_BUCKET).
//
// ESSAY_TEXT_BUCKET unset (previews, local PGlite): every essay is null. Nothing is cached: each
// call reads S3. Errors return null and log a fixed code only (never the key or the text).
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";

export const ESSAY_TEXT_BUCKET_ENV = "ESSAY_TEXT_BUCKET";
export const ESSAY_TEXT_PREFIX = "essays/text/";

/** Minimal S3 client surface (tests pass a fake). */
export interface S3GetLike {
  send(command: GetObjectCommand): Promise<{ Body?: { transformToString(encoding?: string): Promise<string> } }>;
}

export interface EssayTextDeps {
  env?: Readonly<Record<string, string | undefined>>;
  client?: S3GetLike;
}

async function readObject(client: S3GetLike, bucket: string, key: string): Promise<string | null> {
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!out.Body) {
      console.error("[essay-text] body_missing");
      return null;
    }
    return await out.Body.transformToString("utf-8");
  } catch {
    console.error("[essay-text] s3_read_failed");
    return null;
  }
}

export async function loadEssayText(textS3Key: string | null, deps: EssayTextDeps = {}): Promise<string | null> {
  const bucket = (deps.env ?? process.env)[ESSAY_TEXT_BUCKET_ENV];
  if (!bucket || !textS3Key) return null;
  if (!textS3Key.startsWith(ESSAY_TEXT_PREFIX)) {
    console.error("[essay-text] key_rejected");
    return null;
  }
  if (deps.client) return readObject(deps.client, bucket, textS3Key);
  const s3 = new S3Client({});
  try {
    return await readObject(s3, bucket, textS3Key);
  } finally {
    s3.destroy();
  }
}

/** Paragraphs are separated by blank lines; blank ones are dropped. Plain text only, never HTML. */
export function textParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
