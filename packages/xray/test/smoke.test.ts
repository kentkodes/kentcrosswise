import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

describe("@kcw/xray", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/xray");
  });
});
