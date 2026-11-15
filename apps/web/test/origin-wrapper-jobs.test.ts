import { describe, expect, it, vi } from "vitest";
import { isJobEvent, originGuardedWrapper } from "../src/server/origin-wrapper";
import { jobs } from "../src/server/jobs";

const ENV = { AWS_LAMBDA_FUNCTION_NAME: "kcw-prod-server" };

async function setup(registry: Record<string, ReturnType<typeof vi.fn>>) {
  const inner = vi.fn(async () => ({ statusCode: 200 }));
  const base = { name: "aws-lambda", supportStreaming: false, wrapper: vi.fn(async () => inner) };
  const handler = await originGuardedWrapper(base, ENV, registry).wrapper("h", "c");
  return { handler, inner };
}

describe("job events in the origin wrapper", () => {
  it("routes a valid job event to the registry, never to the guard or the OpenNext handler", async () => {
    const job = vi.fn(async () => ({ code: "ok", counts: { sent: 2 } }));
    const { handler, inner } = await setup({ "social-daily": job });
    const out = await handler({ kcw_job: "social-daily", scheduled_time: "2026-11-15T06:15:00Z" });
    expect(out).toEqual({ job: "social-daily", code: "ok", counts: { sent: 2 } });
    expect(job).toHaveBeenCalledWith({ scheduledTime: "2026-11-15T06:15:00Z" });
    expect(inner).not.toHaveBeenCalled();
  });

  it("defaults counts to an empty object", async () => {
    const { handler } = await setup({ a: vi.fn(async () => ({ code: "off" })) });
    expect(await handler({ kcw_job: "a" })).toEqual({ job: "a", code: "off", counts: {} });
  });

  it("refuses an unknown job name and runs nothing", async () => {
    const job = vi.fn(async () => ({ code: "ok" }));
    const { handler, inner } = await setup({ known: job });
    for (const name of ["other", "toString", "__proto__", ""]) {
      expect(await handler({ kcw_job: name })).toEqual({ code: "unknown_job" });
    }
    expect(job).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
  });

  it("sends a Function URL event through the guard even when body or headers mention kcw_job", async () => {
    const job = vi.fn(async () => ({ code: "ok" }));
    const { handler, inner } = await setup({ known: job });
    const event = {
      version: "2.0",
      rawPath: "/",
      headers: { "x-forwarded-for": "203.0.113.1", kcw_job: "known" },
      requestContext: { http: { method: "POST" } },
      body: JSON.stringify({ kcw_job: "known" }),
      kcw_job: "known",
    };
    expect(await handler(event)).toMatchObject({ statusCode: 503 }); // Lambda without origin config fails closed
    expect(job).not.toHaveBeenCalled();
    expect(inner).not.toHaveBeenCalled();
    for (const partial of [{ headers: {} }, { rawPath: "/" }, { requestContext: {} }]) {
      expect(isJobEvent({ kcw_job: "known", ...partial })).toBe(false);
    }
  });

  it("logs one fixed line and rethrows when a job fails", async () => {
    class BoomError extends Error {}
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler } = await setup({ bad: vi.fn(async () => Promise.reject(new BoomError("private text"))) });
    await expect(handler({ kcw_job: "bad" })).rejects.toBeInstanceOf(BoomError);
    expect(err.mock.calls).toEqual([["[job] bad failed BoomError"]]);
    err.mockRestore();
  });

  it("does not treat arrays, strings, null or non-string names as job events", () => {
    for (const event of [[{ kcw_job: "a" }], "kcw_job", null, undefined, 7, { kcw_job: 1 }, {}, Object.create({ kcw_job: "a" })]) {
      expect(isJobEvent(event)).toBe(false);
    }
    expect(isJobEvent({ kcw_job: "a" })).toBe(true);
  });
});

describe("job registry", () => {
  it("has the two stub jobs, off", async () => {
    expect(Object.keys(jobs).sort()).toEqual(["inbox-push", "social-daily"]);
    for (const job of Object.values(jobs)) expect(await job({ scheduledTime: undefined })).toEqual({ code: "off" });
  });
});
