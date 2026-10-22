import { describe, expect, it, vi } from "vitest";
import {
  createOriginGuard,
  guardHandler,
  ORIGIN_HEADER,
  originHeaderMatches,
  type GuardDecision,
} from "../src/server/origin-verify";
import { originGuardedWrapper } from "../src/server/origin-wrapper";

const VALUE = "synthetic-origin-value-0123456789abcdef";

describe("originHeaderMatches", () => {
  it("accepts only the exact value, header name case-insensitive", () => {
    expect(originHeaderMatches({ [ORIGIN_HEADER]: VALUE }, VALUE)).toBe(true);
    expect(originHeaderMatches({ "X-KCW-Origin": VALUE }, VALUE)).toBe(true);
    expect(originHeaderMatches({}, VALUE)).toBe(false);
    expect(originHeaderMatches(undefined, VALUE)).toBe(false);
    expect(originHeaderMatches({ [ORIGIN_HEADER]: "" }, VALUE)).toBe(false);
    expect(originHeaderMatches({ [ORIGIN_HEADER]: `${VALUE}x` }, VALUE)).toBe(false);
    expect(originHeaderMatches({ [ORIGIN_HEADER]: VALUE.slice(0, -1) }, VALUE)).toBe(false);
  });

  it("never matches a short expected value", () => {
    expect(originHeaderMatches({ [ORIGIN_HEADER]: "short" }, "short")).toBe(false);
  });
});

describe("createOriginGuard", () => {
  const lambdaEnv = { AWS_LAMBDA_FUNCTION_NAME: "kcw-prod-server" };

  it("loads the expected value once (name + key) and checks every request", async () => {
    const loadSecret = vi.fn(async () => VALUE);
    const guard = createOriginGuard({
      env: { ...lambdaEnv, KCW_ORIGIN_VERIFY_SECRET: "kcw/prod/origin-verify", KCW_ORIGIN_VERIFY_KEY: "origin_verify" },
      loadSecret,
    });
    expect(await guard({})).toBe("deny");
    expect(await guard({ [ORIGIN_HEADER]: "wrong" })).toBe("deny");
    expect(await guard({ [ORIGIN_HEADER]: VALUE })).toBe("allow");
    expect(loadSecret).toHaveBeenCalledTimes(1);
    expect(loadSecret).toHaveBeenCalledWith("kcw/prod/origin-verify", "origin_verify");
  });

  it("reads SSM parameters without a key", async () => {
    const loadSecret = vi.fn(async () => VALUE);
    const guard = createOriginGuard({ env: { KCW_ORIGIN_VERIFY_SECRET: "/kcw/preview/pr-3/origin-verify" }, loadSecret });
    expect(await guard({ [ORIGIN_HEADER]: VALUE })).toBe("allow");
    expect(loadSecret).toHaveBeenCalledWith("/kcw/preview/pr-3/origin-verify", undefined);
  });

  it("fails closed in Lambda without configuration, and is off outside Lambda", async () => {
    const loadSecret = vi.fn(async () => VALUE);
    expect(await createOriginGuard({ env: lambdaEnv, loadSecret })({ [ORIGIN_HEADER]: VALUE })).toBe("deny");
    expect(await createOriginGuard({ env: {}, loadSecret })({})).toBe("allow");
    expect(loadSecret).not.toHaveBeenCalled();
  });

  it("reports unavailable when the secret cannot be read, and retries later", async () => {
    const loadSecret = vi.fn().mockRejectedValueOnce(new Error("AccessDenied")).mockResolvedValue(VALUE);
    const guard = createOriginGuard({ env: { ...lambdaEnv, KCW_ORIGIN_VERIFY_SECRET: "/x" }, loadSecret });
    expect(await guard({ [ORIGIN_HEADER]: VALUE })).toBe("unavailable");
    expect(await guard({ [ORIGIN_HEADER]: VALUE })).toBe("allow");
    expect(loadSecret).toHaveBeenCalledTimes(2);
  });
});

describe("guardHandler / originGuardedWrapper", () => {
  const event = (headers?: Record<string, string>) => ({ rawPath: "/hub", headers });

  it("returns 403 without calling Next for a missing or wrong header, and passes the right one", async () => {
    const inner = vi.fn(async () => ({ statusCode: 200, headers: {}, body: "ok" }));
    const guard = async (h: Parameters<typeof originHeaderMatches>[0]): Promise<GuardDecision> =>
      originHeaderMatches(h, VALUE) ? "allow" : "deny";
    const handler = guardHandler(inner, guard);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await handler(event())).toMatchObject({ statusCode: 403, body: "Forbidden" });
    expect(await handler(event({ [ORIGIN_HEADER]: "nope" }))).toMatchObject({ statusCode: 403 });
    expect(await handler({ type: "warmer" })).toMatchObject({ statusCode: 403 });
    expect(inner).not.toHaveBeenCalled();
    expect(await handler(event({ [ORIGIN_HEADER]: VALUE }), { ctx: 1 })).toEqual({ statusCode: 200, headers: {}, body: "ok" });
    expect(inner).toHaveBeenCalledWith(event({ [ORIGIN_HEADER]: VALUE }), { ctx: 1 });
  });

  it("returns 503 when the expected value is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handler = guardHandler(vi.fn(), async () => "unavailable");
    expect(await handler(event({ [ORIGIN_HEADER]: VALUE }))).toMatchObject({ statusCode: 503 });
  });

  it("wraps OpenNext's base wrapper and fails closed in Lambda without config", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inner = vi.fn(async () => ({ statusCode: 200 }));
    const base = { name: "aws-lambda", supportStreaming: false, wrapper: vi.fn(async () => inner) };
    const wrapped = originGuardedWrapper(base, { AWS_LAMBDA_FUNCTION_NAME: "kcw-prod-server" });
    expect(wrapped.name).toBe("kcw-origin-guard");
    expect(wrapped.supportStreaming).toBe(false);
    const handler = await wrapped.wrapper("h", "c");
    expect(base.wrapper).toHaveBeenCalledWith("h", "c");
    expect(await handler(event({ [ORIGIN_HEADER]: VALUE }))).toMatchObject({ statusCode: 403 });
    expect(inner).not.toHaveBeenCalled();
  });
});
