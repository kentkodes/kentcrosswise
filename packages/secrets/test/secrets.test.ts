import { afterEach, describe, expect, it } from "vitest";
import {
  FakeAwsSecrets,
  SecretAccessError,
  SecretFormatError,
  SecretKeyMissingError,
  SecretNotFoundError,
  SecretStore,
  createFakeSecrets,
  getSecret,
  setDefaultSecretStore,
} from "../src/index";

// Obviously fake values; nothing here is a real credential.
const WEB = { auth_secret: "fake-auth-secret", owner_email: "owner@example.invalid", port: 5432 };

describe("SecretStore reads", () => {
  it("parses JSON secrets and returns one key", async () => {
    const { store } = createFakeSecrets({ "kcw/prod/web": WEB });
    expect(await store.get("kcw/prod/web", "auth_secret")).toBe("fake-auth-secret");
    expect(await store.get("kcw/prod/web", "port")).toBe("5432");
    expect(await store.get("kcw/prod/web")).toEqual(WEB);
  });

  it("returns the raw string for non-JSON values", async () => {
    const { store } = createFakeSecrets({ "kcw/plain": "just-a-string" });
    expect(await store.get("kcw/plain")).toBe("just-a-string");
  });

  it("caches per process: one AWS call for repeated and concurrent reads", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/prod/web": WEB });
    await Promise.all([store.get("kcw/prod/web", "auth_secret"), store.get("kcw/prod/web")]);
    await store.get("kcw/prod/web", "owner_email");
    expect(aws.calls).toEqual([{ command: "GetSecretValue", name: "kcw/prod/web" }]);
  });

  it("clearCache forces a fresh read", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/prod/web": WEB });
    await store.get("kcw/prod/web");
    store.clearCache("kcw/prod/web");
    await store.get("kcw/prod/web");
    expect(aws.calls).toHaveLength(2);
  });

  it("throws SecretKeyMissingError for a missing key", async () => {
    const { store } = createFakeSecrets({ "kcw/prod/web": WEB });
    await expect(store.get("kcw/prod/web", "nope")).rejects.toBeInstanceOf(SecretKeyMissingError);
  });

  it("throws SecretFormatError without leaking the value when a key is asked of a non-JSON secret", async () => {
    const { store } = createFakeSecrets({ "kcw/plain": "{not json super-secret-value" });
    const err = await store.get("kcw/plain", "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretFormatError);
    expect(String((err as Error).message)).not.toContain("super-secret-value");
    expect((err as Error).cause).toBeUndefined();
  });

  it("throws SecretNotFoundError and does not cache the failure", async () => {
    const { store, aws } = createFakeSecrets();
    await expect(store.get("kcw/missing")).rejects.toBeInstanceOf(SecretNotFoundError);
    aws.values.set("kcw/missing", "now-here");
    expect(await store.get("kcw/missing")).toBe("now-here");
    expect(aws.calls).toHaveLength(2);
  });

  it("wraps other AWS errors in SecretAccessError", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/prod/web": WEB });
    aws.failNextWith = "AccessDeniedException";
    const err = await store.get("kcw/prod/web").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecretAccessError);
    expect((err as Error).message).toContain("AccessDeniedException");
    // retry succeeds: errors are not cached
    expect(await store.get("kcw/prod/web", "auth_secret")).toBe("fake-auth-secret");
  });
});

describe("SSM SecureString names (D21)", () => {
  const PARAM = "/kcw/preview/pr-7/database-url";
  const URL = "postgres://fake-user:fake-pass@db.example.invalid/neondb";

  it("reads names starting with / from SSM with decryption, never from Secrets Manager", async () => {
    const sm = new FakeAwsSecrets();
    const ssm = new FakeAwsSecrets({ [PARAM]: URL });
    const store = new SecretStore({ secretsManager: sm, ssm });
    expect(await store.get(PARAM)).toBe(URL);
    expect(ssm.calls).toEqual([{ command: "GetParameter", name: PARAM }]);
    expect(sm.calls).toEqual([]);
  });

  it("maps ParameterNotFound to SecretNotFoundError", async () => {
    const { store } = createFakeSecrets();
    await expect(store.get("/kcw/preview/pr-404/database-url")).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("writes SSM parameters as SecureString with Overwrite", async () => {
    const { store, aws } = createFakeSecrets();
    await store.put(PARAM, URL);
    expect(aws.values.get(PARAM)).toBe(URL);
    expect(aws.calls).toEqual([{ command: "PutParameter", name: PARAM }]);
  });
});

describe("SecretStore writes", () => {
  it("put stores JSON and refreshes the cache", async () => {
    const { store, aws } = createFakeSecrets({ "kcw/prod/social/instagram": { long_lived_token: "old" } });
    expect(await store.get("kcw/prod/social/instagram", "long_lived_token")).toBe("old");
    await store.put("kcw/prod/social/instagram", { long_lived_token: "new" });
    expect(await store.get("kcw/prod/social/instagram", "long_lived_token")).toBe("new");
    expect(JSON.parse(aws.values.get("kcw/prod/social/instagram") ?? "")).toEqual({ long_lived_token: "new" });
  });

  it("patch re-reads from AWS and keeps other keys", async () => {
    const { store, aws } = createFakeSecrets({
      "kcw/prod/social/tiktok": { client_key: "ck", refresh_token: "r1" },
    });
    await store.get("kcw/prod/social/tiktok");
    // Someone else rotated the token meanwhile; patch must not write back the stale cached copy.
    aws.values.set("kcw/prod/social/tiktok", JSON.stringify({ client_key: "ck2", refresh_token: "r2" }));
    await store.patch("kcw/prod/social/tiktok", { refresh_token: "r3" });
    expect(JSON.parse(aws.values.get("kcw/prod/social/tiktok") ?? "")).toEqual({
      client_key: "ck2",
      refresh_token: "r3",
    });
  });

  it("patch refuses non-JSON secrets", async () => {
    const { store } = createFakeSecrets({ "kcw/plain": "x" });
    await expect(store.patch("kcw/plain", { a: "b" })).rejects.toBeInstanceOf(SecretFormatError);
  });
});

describe("module-level getSecret", () => {
  afterEach(() => setDefaultSecretStore(undefined));

  it("uses the replaceable default store", async () => {
    setDefaultSecretStore(createFakeSecrets({ "kcw/prod/models": { anthropic_api_key: "fake-key" } }).store);
    expect(await getSecret("kcw/prod/models", "anthropic_api_key")).toBe("fake-key");
  });
});
