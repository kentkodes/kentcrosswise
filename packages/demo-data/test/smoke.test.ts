import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

describe("@kcw/demo-data", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/demo-data");
  });
});
