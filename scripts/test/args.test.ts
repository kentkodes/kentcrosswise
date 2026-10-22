import { describe, expect, it } from "vitest";
import { parseArgs } from "../lib/args";

describe("parseArgs", () => {
  it("parses flags, key value and key=value", () => {
    expect(parseArgs(["--dry-run", "--pglite", "./db", "--secret=kcw/prod/migrator"])).toEqual({
      "dry-run": true,
      pglite: "./db",
      secret: "kcw/prod/migrator",
    });
  });
});
