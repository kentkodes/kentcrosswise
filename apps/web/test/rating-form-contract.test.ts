// Source-level contract for the essay rating form. The markup was restyled, so this pins what the server action
// depends on: field names, values, the required star choice, the hidden essay id, and that the form posts to
// rateAction, which reads the same names. A cheap source-text check, like owner-pages-auth.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../src/app/(owner)/essays/[id]/", import.meta.url));
const form = readFileSync(`${dir}rating-form.tsx`, "utf8");
const actions = readFileSync(fileURLToPath(new URL("../src/app/(owner)/essays/actions.ts", import.meta.url)), "utf8");

// Every <input ... /> element in the form, as source text.
function inputs(src: string): string[] {
  return src.match(/<input[\s\S]*?\/>/g) ?? [];
}

function named(name: string): string[] {
  return inputs(form).filter((el) => el.includes(`name="${name}"`));
}

describe("rating form contract", () => {
  it("posts to rateAction", () => {
    expect(form).toContain("action={rateAction}");
    expect(form).toMatch(/import \{ rateAction \} from "\.\.\/actions"/);
  });

  it("offers overall stars 1 to 5 as required radios", () => {
    expect(form).toContain("const STARS = [1, 2, 3, 4, 5] as const;");
    const stars = named("stars");
    expect(stars).toHaveLength(1);
    expect(stars[0]).toContain('type="radio"');
    expect(stars[0]).toContain("value={s}");
    expect(stars[0]).toContain("required");
  });

  it("offers each worked tag as a checkbox", () => {
    const worked = named("worked");
    expect(worked).toHaveLength(1);
    expect(worked[0]).toContain('type="checkbox"');
    expect(worked[0]).toContain("value={t}");
  });

  it("offers length felt as radios, with an empty value for Not sure", () => {
    const lengths = named("length_felt");
    expect(lengths).toHaveLength(2);
    expect(lengths.some((el) => el.includes('type="radio"') && el.includes('value=""'))).toBe(true);
    expect(lengths.some((el) => el.includes('type="radio"') && el.includes("value={l}"))).toBe(true);
  });

  it("carries the essay id as a hidden field", () => {
    const id = named("essay_id");
    expect(id).toHaveLength(1);
    expect(id[0]).toContain('type="hidden"');
    expect(id[0]).toContain("value={essayId}");
  });

  it("uses only the field names that rateAction reads", () => {
    for (const name of ["essay_id", "stars", "worked", "length_felt"]) {
      expect(actions).toContain(`"${name}"`);
    }
  });
});
