// P2-11: the planner and public-title nodes on FakeProvider (schema validation, one retry) and the
// public-text rules they feed (§4.5, Q8).
import { FakeProvider } from "@kcw/core/models";
import { PRIVATE_TITLE, createSanitizer } from "@kcw/core/sanitize";
import { describe, expect, it } from "vitest";
import {
  MAX_SUBTASKS,
  ModelPlanner,
  PLANNER_SYSTEM,
  PUBLIC_TITLE_SYSTEM,
  PlannerOutputError,
  parsePlan,
  parseSubtasks,
  publicText,
} from "../src/nodes";
import { MAX_PLANNER_INPUT_BYTES, contractViolations } from "../src/nodes/planner";
import { PlannerInputError } from "../src/graph/types";

const REQ = { task_id: 1, owner_text: "Add a healthz page and a status badge", is_private: true, brief: "## Layout\n\nagents/  code" };
const REST = { acceptance: ["It works."], scope: [], context: [] };

/** A provider answering each call with the next scripted text. */
function scripted(...answers: string[]) {
  const systems: (string | undefined)[] = [];
  const provider = new FakeProvider({
    complete: (req) => {
      systems.push(req.system);
      const text = answers.shift();
      return text === undefined ? new Error("no more answers") : { text };
    },
  });
  return { provider, systems, planner: new ModelPlanner({ provider }) };
}

describe("planner node", () => {
  it("splits into subtasks with the planner prompt; the task text is in the prompt", async () => {
    const { provider, systems, planner } = scripted('{"subtasks": ["Add a /healthz route", "Add a status badge"]}');
    expect(await planner.split(REQ)).toEqual(["Add a /healthz route", "Add a status badge"]);
    expect(systems).toEqual([PLANNER_SYSTEM]);
    expect(provider.calls[0]!.input).toContain(REQ.owner_text);
  });

  it("accepts a fenced reply and trims items", async () => {
    const { planner } = scripted('```json\n{"subtasks": ["  Add a /healthz route  "]}\n```');
    expect(await planner.split(REQ)).toEqual(["Add a /healthz route"]);
  });

  it("retries a malformed reply once, telling the model what was wrong", async () => {
    const { provider, planner } = scripted("Sure! Here is the plan.", '{"subtasks": ["Add a /healthz route"]}');
    expect(await planner.split(REQ)).toEqual(["Add a /healthz route"]);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain("Your previous reply was invalid: no JSON object.");
  });

  it("throws PlannerOutputError after the retry fails too (no third call)", async () => {
    const { provider, planner } = scripted('{"subtasks": []}', '{"steps": ["x"]}', '{"subtasks": ["x"]}');
    const err = await planner.split(REQ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerOutputError);
    expect(err).toMatchObject({ node: "planner", reason: "subtasks is not an array" });
    expect(provider.calls).toHaveLength(2);
  });

  it("a reply stopped at the token limit throws PlannerOutputError at once (no retry)", async () => {
    const provider = new FakeProvider({ complete: { text: "", stop: "max_tokens" } });
    const err = await new ModelPlanner({ provider }).split(REQ).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "PlannerOutputError", node: "planner", reason: "reply stopped: max_tokens" });
    expect(provider.calls).toHaveLength(1);
  });

  it("a refused reply throws PlannerOutputError at once in plan() (no retry)", async () => {
    const provider = new FakeProvider({ complete: { text: "", stop: "refusal" } });
    await expect(new ModelPlanner({ provider }).plan(REQ)).rejects.toMatchObject({
      name: "PlannerOutputError",
      node: "public_title",
      reason: "reply stopped: refusal",
    });
    expect(provider.calls).toHaveLength(1);
  });

  it("asks with 8000 max tokens by default", async () => {
    const limits: (number | undefined)[] = [];
    const provider = new FakeProvider({
      complete: (req) => {
        limits.push(req.maxTokens);
        return { text: '{"subtasks": ["Add a /healthz route"]}' };
      },
    });
    await new ModelPlanner({ provider }).split(REQ);
    expect(limits).toEqual([8000]);
  });

  it("propagates provider errors unchanged", async () => {
    const provider = new FakeProvider({ complete: new Error("HTTP 529") });
    await expect(new ModelPlanner({ provider }).split(REQ)).rejects.toThrow("HTTP 529");
  });

  it.each([
    ["not JSON", "{subtasks: [1]}", "not valid JSON"],
    ["an array", '["a"]', "no JSON object"],
    ["no items", '{"subtasks": []}', `subtasks must have 1 to ${MAX_SUBTASKS} items, not 0`],
    ["too many items", JSON.stringify({ subtasks: Array.from({ length: MAX_SUBTASKS + 1 }, (_, i) => `step ${i}`) }), `subtasks must have 1 to ${MAX_SUBTASKS} items, not ${MAX_SUBTASKS + 1}`],
    ["a non-string item", '{"subtasks": ["a", 2]}', "subtasks[1] is not a string"],
    ["a blank item", '{"subtasks": ["a", "  "]}', "subtasks[1] is empty"],
    ["an over-long item", JSON.stringify({ subtasks: ["x".repeat(4001)] }), "subtasks[0] is longer than 4000 characters"],
  ])("schema: rejects %s", (_name, raw, reason) => {
    expect(parseSubtasks(raw)).toEqual({ ok: false, reason });
  });
});

describe("public-title node", () => {
  it("returns the title and body with the public-title prompt", async () => {
    const { systems, planner } = scripted(JSON.stringify({ title: "Add a healthz page", body: "Add a /healthz route that returns ok.", acceptance: ["GET /healthz answers ok"], scope: ["apps/web/src"], context: ["agents/orchestrator/src/graph/machine.ts"] }));
    expect(await planner.plan(REQ)).toEqual({ title: "Add a healthz page", body: "Add a /healthz route that returns ok.", acceptance: ["GET /healthz answers ok"], scope: ["apps/web/src"], context: ["agents/orchestrator/src/graph/machine.ts"] });
    expect(systems).toEqual([PUBLIC_TITLE_SYSTEM]);
  });

  it("retries once, then throws PlannerOutputError", async () => {
    const { provider, planner } = scripted('{"title": "x"}', '{"title": "", "body": "b"}');
    await expect(planner.plan(REQ)).rejects.toMatchObject({ name: "PlannerOutputError", node: "public_title", reason: "title is empty" });
    expect(provider.calls[1]!.input).toContain("body is not a string");
  });

  it("schema: a long title is not a schema error (the sanitizer decides)", () => {
    expect(parsePlan(JSON.stringify({ title: "t".repeat(80), body: "b", ...REST }))).toMatchObject({ ok: true });
  });

describe("contract fields", () => {
    const ok = { title: "T", body: "B", acceptance: ["a"], scope: [], context: [] };
    it.each([
      ["no acceptance", { ...ok, acceptance: [] }, "acceptance must have 1 to 10 items, not 0"],
      ["eleven acceptance items", { ...ok, acceptance: Array<string>(11).fill("a") }, "acceptance must have 1 to 10 items, not 11"],
      ["an over-long acceptance item", { ...ok, acceptance: ["x".repeat(401)] }, "acceptance[0] is longer than 400 characters"],
      ["a missing scope", { ...ok, scope: undefined }, "scope is not an array"],
      ["a traversal path", { ...ok, context: ["a/../b"] }, "context[0] is not a valid repository path"],
      ["a leading slash", { ...ok, scope: ["/etc"] }, "scope[0] is not a valid repository path"],
      ["21 paths", { ...ok, scope: Array.from({ length: 21 }, (_, i) => `p${i}`) }, "scope must have 0 to 20 items, not 21"],
    ])("schema: rejects %s", (_name, value, reason) => {
      expect(parsePlan(JSON.stringify(value))).toEqual({ ok: false, reason });
    });

    it("accepts a repository path and normalizes line ends and tabs in the body", () => {
      const r = parsePlan(JSON.stringify({ ...ok, body: "a\r\n\tb", scope: ["agents/orchestrator/src/graph/machine.ts"] }));
      expect(r).toMatchObject({ ok: true, value: { body: "a\n  b", scope: ["agents/orchestrator/src/graph/machine.ts"] } });
    });

    const sanitizer = createSanitizer({ contacts: [{ name: "Jane Doe", aliases: ["Janie"] }] });
    it("a file path passes checkText with the url code ignored; a contact name in a path fails", () => {
      const clean = { ...ok, scope: ["agents/orchestrator/src/graph/machine.ts"], context: ["docs/DESIGN.md"] };
      expect(contractViolations(clean, sanitizer)).toEqual([]);
      expect(contractViolations({ ...clean, context: ["docs/jane-notes.md"] }, sanitizer)).toEqual(["contact"]);
      expect(contractViolations({ ...ok, acceptance: ["See https://example.com"] }, sanitizer)).toEqual(["url"]);
    });
  });

  describe("repository brief in the prompt", () => {
    it("puts the brief in a repository block before the task", async () => {
      const { provider, planner } = scripted('{"subtasks": ["x"]}');
      await planner.split(REQ);
      const input = provider.calls[0]!.input as string;
      expect(input.indexOf("<repository>")).toBeLessThan(input.indexOf("<task>"));
      expect(input).toContain("agents/  code");
    });

    it("an oversized prompt throws PlannerInputError and makes no model call", async () => {
      const { provider, planner } = scripted('{"subtasks": ["x"]}');
      await expect(planner.split({ ...REQ, brief: "b".repeat(MAX_PLANNER_INPUT_BYTES) })).rejects.toBeInstanceOf(PlannerInputError);
      await expect(planner.plan({ ...REQ, owner_text: "é".repeat(MAX_PLANNER_INPUT_BYTES) })).rejects.toBeInstanceOf(PlannerInputError);
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("replan input (AR5b)", () => {
    const previous = {
      v: 1 as const, task: 1, revision: 1, issue: 7, goal: "Add a /healthz route.", acceptance: ["GET /healthz answers ok"],
      base: "1".repeat(40), prerequisites: [], scope: ["apps/web/src"], context: ["apps/web/src/app"],
    };
    const failure = "Revision 1 used 3 of 3 attempts without an approved QA review.";

    it("puts the previous contract and the failure line between the repository and the task", async () => {
      const { provider, planner } = scripted(JSON.stringify({ title: "Add a healthz page", body: "Add it.", ...REST }));
      await planner.plan({ ...REQ, previous, failure });
      const input = provider.calls[0]!.input as string;
      expect(input.indexOf("<repository>")).toBeLessThan(input.indexOf("<previous_contract>"));
      expect(input.indexOf("<previous_contract>")).toBeLessThan(input.indexOf("<failure>"));
      expect(input.indexOf("<failure>")).toBeLessThan(input.indexOf("<task>"));
      expect(input).toContain("goal: Add a /healthz route.");
      expect(input).toContain("acceptance: GET /healthz answers ok");
      expect(input).toContain(failure);
    });

    it("a first plan has neither block, and the split never gets them", async () => {
      const { provider, planner } = scripted(JSON.stringify({ title: "Add a healthz page", body: "Add it.", ...REST }), '{"subtasks": ["x"]}');
      await planner.plan(REQ);
      await planner.split({ ...REQ, previous, failure });
      for (const call of provider.calls) expect(call.input as string).not.toContain("<previous_contract>");
    });

    it("a previous contract that makes the prompt too large throws PlannerInputError and makes no model call", async () => {
      const { provider, planner } = scripted("{}");
      await expect(planner.plan({ ...REQ, previous: { ...previous, goal: "g".repeat(MAX_PLANNER_INPUT_BYTES) }, failure })).rejects.toBeInstanceOf(PlannerInputError);
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("public text (§4.5)", () => {
    const sanitizer = createSanitizer({ contacts: [{ name: "Jane Doe", aliases: ["Janie"] }] });

    it("a clean plan is published as is", () => {
      expect(publicText({ title: "Add a healthz page", body: "Add a route.\n\nTest it.", ...REST }, sanitizer)).toEqual({
        publicTitle: "Add a healthz page",
        issue: { title: "Add a healthz page", body: "Add a route.\n\nTest it." },
        body: { ok: true, violations: [] },
      });
    });

    it("a title naming a contact becomes Private task", () => {
      const t = publicText({ title: "Build Janie's page", body: "Add a page.", ...REST }, sanitizer);
      expect(t.publicTitle).toBeNull();
      expect(t.issue.title).toBe(PRIVATE_TITLE);
    });

    it("a body longer than 60 characters passes; one with a URL does not", () => {
      const long = "Add a route that answers ok to every request, with a unit test and an e2e test.";
      expect(publicText({ title: "Add a page", body: long, ...REST }, sanitizer).body.ok).toBe(true);
      expect(publicText({ title: "Add a page", body: `${long}\nSee https://example.org`, ...REST }, sanitizer).body).toEqual({ ok: false, violations: ["url"] });
    });
  });
});
