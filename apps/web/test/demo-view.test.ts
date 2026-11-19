import { describe, expect, it } from "vitest";
import { buildDemoView } from "../src/app/(public)/demo/demo-view";

describe("essays view", () => {
  it("builds the static link-only feed with a because line", () => {
    const { essays } = buildDemoView();
    expect(essays.feed.length).toBeGreaterThanOrEqual(5);
    expect(essays.feed.every((e) => e.sourceUrl.startsWith("https://www.gutenberg.org/ebooks/"))).toBe(true);
    expect(essays.feed.some((e) => e.year === null)).toBe(true);
    expect(essays.recommended?.reason).toBe("Because you liked Fenimore Cooper's Literary Offences");
    expect(essays.feed.some((e) => e.id === essays.recommended?.id)).toBe(true);
  });

  it("is deterministic", () => {
    expect(buildDemoView()).toEqual(buildDemoView());
  });
});
