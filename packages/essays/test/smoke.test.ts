import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index";

describe("@kcw/essays", () => {
  it("is importable", () => {
    expect(PACKAGE_NAME).toBe("@kcw/essays");
  });
});
