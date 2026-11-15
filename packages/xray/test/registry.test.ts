import { describe, expect, it } from "vitest";
import { XRAY, XRAY_IDS, type XrayEntry } from "../src/index";

describe("X-ray registry", () => {
  it("has entries", () => {
    expect(XRAY_IDS.length).toBeGreaterThanOrEqual(8);
  });

  it("ids are unique, lowercase kebab-case", () => {
    expect(new Set(XRAY_IDS).size).toBe(XRAY_IDS.length);
    for (const id of XRAY_IDS) expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it.each(XRAY_IDS)("%s is complete and short", (id) => {
    const entry: XrayEntry = XRAY[id];
    expect(Object.keys(entry).sort()).toEqual(["tech", "what", "label", "why"].sort());
    for (const key of ["label", "tech", "what", "why"] as const) {
      expect(entry[key].trim(), `${id}.${key}`).not.toBe("");
      expect(entry[key], `${id}.${key} has no stray space`).toBe(entry[key].trim());
    }
    expect(entry.label.length).toBeLessThanOrEqual(24);
    expect(entry.tech.length).toBeLessThanOrEqual(48);
    expect(entry.what.length).toBeLessThanOrEqual(220);
    expect(entry.why.length).toBeLessThanOrEqual(220);
  });
});
