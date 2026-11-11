import type { GetObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEssayText, textParagraphs, type S3GetLike } from "../src/server/essay-text";

const KEY = "essays/text/0123abcd.txt";
const BODY = "First paragraph.\n\nSecond paragraph.";
const ENV = { ESSAY_TEXT_BUCKET: "kentcrosswise-pipelines-123456789012" };

function fakeClient(result: { body?: string | null; error?: Error } = {}) {
  const sent: GetObjectCommand[] = [];
  const client: S3GetLike = {
    async send(command) {
      sent.push(command);
      if (result.error) throw result.error;
      if (result.body === null) return {};
      return { Body: { transformToString: async () => result.body ?? BODY } };
    },
  };
  return { client, sent };
}

describe("loadEssayText", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errors.mockRestore();
  });

  it("reads the object from the configured bucket under the key", async () => {
    const { client, sent } = fakeClient();
    await expect(loadEssayText(KEY, { env: ENV, client })).resolves.toBe(BODY);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input).toEqual({ Bucket: ENV.ESSAY_TEXT_BUCKET, Key: KEY });
    expect(errors).not.toHaveBeenCalled();
  });

  it("returns null without reading when the key is missing", async () => {
    const { client, sent } = fakeClient();
    await expect(loadEssayText(null, { env: ENV, client })).resolves.toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("returns null without reading when the key is outside essays/text/", async () => {
    const { client, sent } = fakeClient();
    await expect(loadEssayText("essays/other/x.txt", { env: ENV, client })).resolves.toBeNull();
    await expect(loadEssayText("essays/textual/x.txt", { env: ENV, client })).resolves.toBeNull();
    expect(sent).toHaveLength(0);
    expect(errors).toHaveBeenCalledWith("[essay-text] key_rejected");
  });

  it("returns null and logs a fixed code on an S3 error, never the key or the text", async () => {
    const { client } = fakeClient({ error: new Error(`NoSuchKey ${KEY} ${BODY}`) });
    await expect(loadEssayText(KEY, { env: ENV, client })).resolves.toBeNull();
    expect(errors).toHaveBeenCalledWith("[essay-text] s3_read_failed");
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("First paragraph");
  });

  it("returns null when the response has no body", async () => {
    const { client } = fakeClient({ body: null });
    await expect(loadEssayText(KEY, { env: ENV, client })).resolves.toBeNull();
    expect(errors).toHaveBeenCalledWith("[essay-text] body_missing");
  });

  it("returns null without reading when no bucket is configured", async () => {
    const { client, sent } = fakeClient();
    await expect(loadEssayText(KEY, { env: {}, client })).resolves.toBeNull();
    await expect(loadEssayText(KEY, { env: { ESSAY_TEXT_BUCKET: "" }, client })).resolves.toBeNull();
    expect(sent).toHaveLength(0);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("textParagraphs", () => {
  it("splits on blank lines, including CRLF, and drops blank paragraphs", () => {
    expect(textParagraphs("one\n\ntwo\r\n\r\nthree\n \n\n four ")).toEqual(["one", "two", "three", "four"]);
  });

  it("keeps single newlines inside a paragraph and treats markup as plain text", () => {
    expect(textParagraphs("line a\nline b\n\n<script>x</script>")).toEqual(["line a\nline b", "<script>x</script>"]);
  });

  it("returns no paragraphs for empty or blank text", () => {
    expect(textParagraphs("")).toEqual([]);
    expect(textParagraphs(" \n\n \t ")).toEqual([]);
  });
});
