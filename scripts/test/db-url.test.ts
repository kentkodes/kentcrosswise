import { SecretAccessError, SecretKeyMissingError, SecretNotFoundError } from "@kcw/secrets";
import { describe, expect, it } from "vitest";
import { DbNotConfigured, readDbUrl } from "../lib/db";

const URL_OK = "postgresql://migrator:synthetic@ep-example.invalid/kcw?sslmode=require";

describe("readDbUrl", () => {
  it("returns a postgres URL", async () => {
    expect(await readDbUrl("kcw/prod/migrator", async () => ` ${URL_OK} `, true)).toBe(URL_OK);
  });

  it("with --skip-if-unset, turns an unset secret into DbNotConfigured", async () => {
    const cases: (() => Promise<string>)[] = [
      async () => {
        throw new SecretNotFoundError('Secret "kcw/prod/migrator" has no value', "kcw/prod/migrator");
      },
      async () => {
        throw new SecretKeyMissingError("kcw/prod/migrator", "db_url");
      },
      async () => "",
      async () => "fill me in",
    ];
    for (const read of cases) {
      await expect(readDbUrl("kcw/prod/migrator", read, true)).rejects.toBeInstanceOf(DbNotConfigured);
    }
  });

  it("still fails on access errors, and on bad values when not optional", async () => {
    const denied = async (): Promise<string> => {
      throw new SecretAccessError("AccessDenied reading kcw/prod/migrator", "kcw/prod/migrator");
    };
    await expect(readDbUrl("kcw/prod/migrator", denied, true)).rejects.toBeInstanceOf(SecretAccessError);
    await expect(readDbUrl("kcw/prod/migrator", async () => "", false)).rejects.toThrow(/not a postgres/);
  });

  it("never puts the value in the message", async () => {
    const value = "mysql://user:pw-synthetic@host/db";
    const err = await readDbUrl("s", async () => value, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbNotConfigured);
    expect(String((err as Error).message)).not.toContain("pw-synthetic");
  });
});
