import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  CONTRACT_VERSION,
  MAX_CONTRACT_BYTES,
  canonicalContract,
  contractHash,
  isContractPath,
  parseContract,
  type TaskContract,
} from "../src/contract/index";

const A = "a".repeat(40);
const B = "b".repeat(40);
const base = (): TaskContract => ({
  v: 1,
  task: 7,
  revision: 1,
  issue: 12,
  goal: "Add a synthetic widget.\nKeep it small.",
  acceptance: ["The widget renders.", "Tests pass."],
  base: A,
  prerequisites: [{ task: 3, merge: B }],
  scope: ["apps/web/src/widget"],
  context: ["docs/agents/INSTRUCTIONS.md"],
});
const text = (c: unknown) => canonicalContract(c as TaskContract);
const bad = (c: unknown) => expect(() => parseContract(text(c))).toThrow("contract_invalid");

describe("task contract", () => {
  it("round-trips with a stable canonical form and hash", () => {
    const c = base();
    const t = canonicalContract(c);
    expect(CONTRACT_VERSION).toBe(1);
    expect(parseContract(t)).toEqual(c);
    expect(contractHash(c)).toBe(createHash("sha256").update(t).digest("hex"));
    expect(contractHash(parseContract(t))).toBe(contractHash(c));
    // keys sorted recursively, no whitespace
    expect(t.startsWith('{"acceptance":')).toBe(true);
    expect(t).toContain('"prerequisites":[{"merge":');
    expect(t).not.toMatch(/\s(?=")|: /);
  });

  it("rejects a non-canonical but equivalent text", () => {
    const c = base();
    expect(() => parseContract(JSON.stringify(c, null, 1))).toThrow("contract_invalid");
    expect(() => parseContract(JSON.stringify(c))).toThrow("contract_invalid"); // key order differs
    const rev = { ...c, prerequisites: [{ task: 3, merge: B }] };
    expect(() => parseContract(JSON.stringify(rev))).toThrow("contract_invalid");
  });

  it("rejects unknown keys, versions, non-text and bad JSON", () => {
    bad({ ...base(), extra: 1 });
    bad({ ...base(), v: 2 });
    bad({ ...base(), prerequisites: [{ task: 3, merge: B, x: 1 }] });
    const { scope: _s, ...missing } = base();
    bad(missing);
    expect(() => parseContract("not json")).toThrow("contract_invalid");
    expect(() => parseContract(undefined)).toThrow("contract_invalid");
    expect(() => parseContract("[]")).toThrow("contract_invalid");
  });

  it("enforces every bound", () => {
    const ok = (c: unknown) => expect(parseContract(text(c))).toBeTruthy();
    ok({ ...base(), goal: "g".repeat(8000) });
    bad({ ...base(), goal: "g".repeat(8001) });
    bad({ ...base(), goal: "" });
    bad({ ...base(), goal: "café" });
    ok({ ...base(), acceptance: Array.from({ length: 10 }, () => "a".repeat(400)) });
    bad({ ...base(), acceptance: Array.from({ length: 11 }, () => "a") });
    bad({ ...base(), acceptance: [] });
    bad({ ...base(), acceptance: ["a".repeat(401)] });
    bad({ ...base(), acceptance: ["line\nbreak"] });
    ok({ ...base(), prerequisites: [1, 2, 3, 4].map((task) => ({ task, merge: B })) });
    bad({ ...base(), prerequisites: [1, 2, 3, 4, 5].map((task) => ({ task, merge: B })) });
    bad({ ...base(), prerequisites: [{ task: 1, merge: "abc" }] });
    ok({ ...base(), scope: Array.from({ length: 20 }, (_, i) => `a/${i}`), context: Array.from({ length: 20 }, (_, i) => `b/${i}`) });
    bad({ ...base(), scope: Array.from({ length: 21 }, (_, i) => `a/${i}`) });
    bad({ ...base(), context: Array.from({ length: 21 }, (_, i) => `a/${i}`) });
    ok({ ...base(), scope: ["a".repeat(200)] });
    bad({ ...base(), scope: ["a".repeat(201)] });
    bad({ ...base(), task: 0 });
    bad({ ...base(), revision: 1.5 });
    bad({ ...base(), issue: -1 });
    bad({ ...base(), base: "A".repeat(40) });
  });

  it("bounds the whole canonical contract at 24,576 bytes", () => {
    expect(MAX_CONTRACT_BYTES).toBe(24_576);
    // Quotes are escaped in the canonical form, so valid field bounds can exceed the byte cap.
    const heavy = { ...base(), goal: '"'.repeat(8000), acceptance: Array.from({ length: 10 }, () => '"'.repeat(400)),
      scope: Array.from({ length: 20 }, () => "s".repeat(200)), context: Array.from({ length: 20 }, () => "c".repeat(200)) };
    expect(Buffer.byteLength(text(heavy))).toBeGreaterThan(MAX_CONTRACT_BYTES);
    bad(heavy);
    // Grow valid paths one by one: the last accepted contract is just under the cap, the next is refused.
    const grown = { ...base(), goal: '"'.repeat(8000), acceptance: Array.from({ length: 10 }, () => "a".repeat(400)), scope: [] as string[], context: [] as string[] };
    let size = Buffer.byteLength(text(grown));
    expect(size).toBeLessThan(MAX_CONTRACT_BYTES);
    for (let i = 0; i < 40; i++) {
      const next = { ...grown, scope: [...grown.scope], context: [...grown.context] };
      (i < 20 ? next.scope : next.context).push("p".repeat(199) + String(i % 10));
      const nextSize = Buffer.byteLength(text(next));
      if (nextSize > MAX_CONTRACT_BYTES) { bad(next); break; }
      grown.scope = next.scope; grown.context = next.context; size = nextSize;
    }
    expect(size).toBeGreaterThan(MAX_CONTRACT_BYTES - 250);
    expect(parseContract(text(grown))).toEqual(grown);
  });

  it("rejects bad paths through parseContract, not only isContractPath", () => {
    for (const p of ["../x", "a/../../b", "https:x", "/abs", "a//b"]) {
      bad({ ...base(), scope: [p] });
      bad({ ...base(), context: [p] });
    }
    bad({ ...base(), scope: "apps/web" });
    bad({ ...base(), context: [1] });
  });

  it("accepts only strict repository paths", () => {
    for (const p of ["a", "apps/web/src/x.ts", "_x/y-z.1", "docs/agents/INSTRUCTIONS.md"]) expect(isContractPath(p)).toBe(true);
    for (const p of ["../x", "a/../b", "/abs", "a//b", "https://example.invalid/x", "a:b", "-x", ".hidden", "", "a b", "a\\b", "x@y"])
      expect(isContractPath(p)).toBe(false);
  });

  it("never echoes the input in the error", () => {
    try {
      parseContract('{"goal":"SECRET-TEXT"}');
    } catch (e) {
      expect(String(e)).not.toContain("SECRET");
    }
  });
});
