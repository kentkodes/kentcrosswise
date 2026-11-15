import { createECDH } from "node:crypto";
import { createFakeSecrets } from "@kcw/secrets";
import { describe, expect, it } from "vitest";
import { VAPID_WRITTEN_LINE, VapidKeysExistError, writeVapidKeys } from "../lib/vapid-keys";

const NAME = "kcw/test/web";

describe("writeVapidKeys", () => {
  it("writes a valid P-256 pair, keeps other keys, and returns only the fixed line", async () => {
    const { store } = createFakeSecrets({ [NAME]: { db_url: "postgres://x.invalid/y" } });
    const line = await writeVapidKeys(store, NAME);
    expect(line).toBe(VAPID_WRITTEN_LINE);
    const all = (await store.get(NAME)) as Record<string, string>;
    expect(all.db_url).toBe("postgres://x.invalid/y");
    const pub = Buffer.from(all.vapid_public!, "base64url");
    const priv = Buffer.from(all.vapid_private!, "base64url");
    expect(pub.length).toBe(65);
    expect(priv.length).toBe(32);
    const check = createECDH("prime256v1");
    check.setPrivateKey(priv);
    expect(check.getPublicKey().equals(pub)).toBe(true);
    expect(line).not.toContain(all.vapid_public!);
  });

  it("refuses to overwrite existing keys unless rotating", async () => {
    const { store } = createFakeSecrets({ [NAME]: { vapid_public: "old-pub", vapid_private: "old-priv" } });
    await expect(writeVapidKeys(store, NAME)).rejects.toBeInstanceOf(VapidKeysExistError);
    expect(await store.get(NAME, "vapid_private")).toBe("old-priv");
    await writeVapidKeys(store, NAME, { rotate: true });
    expect(await store.get(NAME, "vapid_private")).not.toBe("old-priv");
  });

  it("fails on a missing or non-JSON secret", async () => {
    const { store } = createFakeSecrets({ [NAME]: "plain" });
    await expect(writeVapidKeys(store, NAME)).rejects.toThrow();
    await expect(writeVapidKeys(createFakeSecrets().store, NAME)).rejects.toThrow();
  });
});
