import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/index";
import { SECRET } from "./helpers";

const body = Buffer.from('{"zen":"Synthetic."}', "utf8");
const good = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

describe("verifySignature (X-Hub-Signature-256)", () => {
  it.each<[string, string | undefined, "valid" | "invalid" | "missing"]>([
    ["valid", good, "valid"],
    ["valid, upper-case hex", good.toUpperCase().replace("SHA256=", "sha256="), "valid"],
    ["missing header", undefined, "missing"],
    ["empty header", "", "missing"],
    ["wrong secret", signBody(body, "other-secret"), "invalid"],
    ["body changed", signBody(Buffer.from('{"zen":"Synthetic!"}'), SECRET), "invalid"],
    ["sha1 header format", `sha1=${createHmac("sha1", SECRET).update(body).digest("hex")}`, "invalid"],
    ["no prefix", good.slice("sha256=".length), "invalid"],
    ["truncated", good.slice(0, -2), "invalid"],
    ["not hex", `sha256=${"z".repeat(64)}`, "invalid"],
    ["one bit off", good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"), "invalid"],
  ])("%s", (_label, header, expected) => {
    expect(verifySignature(body, header, SECRET)).toBe(expected);
  });

  it("signs the exact bytes: re-serialized JSON does not verify", () => {
    const raw = Buffer.from('{ "a": 1,  "b": "x" }');
    const header = signBody(raw, SECRET);
    expect(verifySignature(raw, header, SECRET)).toBe("valid");
    expect(verifySignature(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), header, SECRET)).toBe("invalid");
  });

  it("refuses to run with an empty secret", () => {
    expect(() => verifySignature(body, good, "")).toThrow(/empty/);
  });
});
