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

const REQ = { task_id: 1, owner_text: "Add a healthz page and a status badge", is_private: true };

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
    const { systems, planner } = scripted('{"title": "Add a healthz page", "body": "Add a /healthz route that returns ok."}');
    expect(await planner.plan(REQ)).toEqual({ title: "Add a healthz page", body: "Add a /healthz route that returns ok." });
    expect(systems).toEqual([PUBLIC_TITLE_SYSTEM]);
  });

  it("retries once, then throws PlannerOutputError", async () => {
    const { provider, planner } = scripted('{"title": "x"}', '{"title": "", "body": "b"}');
    await expect(planner.plan(REQ)).rejects.toMatchObject({ name: "PlannerOutputError", node: "public_title", reason: "title is empty" });
    expect(provider.calls[1]!.input).toContain("body is not a string");
  });

  it("schema: a long title is not a schema error (the sanitizer decides)", () => {
    expect(parsePlan(JSON.stringify({ title: "t".repeat(80), body: "b" }))).toMatchObject({ ok: true });
  });

  describe("public text (§4.5)", () => {
    const sanitizer = createSanitizer({ contacts: [{ name: "Jane Doe", aliases: ["Janie"] }] });

    it("a clean plan is published as is", () => {
      expect(publicText({ title: "Add a healthz page", body: "Add a route.\n\nTest it." }, sanitizer)).toEqual({
        publicTitle: "Add a healthz page",
        issue: { title: "Add a healthz page", body: "Add a route.\n\nTest it." },
        body: { ok: true, violations: [] },
      });
    });

    it("a title naming a contact becomes Private task", () => {
      const t = publicText({ title: "Build Janie's page", body: "Add a page." }, sanitizer);
      expect(t.publicTitle).toBeNull();
      expect(t.issue.title).toBe(PRIVATE_TITLE);
    });

    it("a body longer than 60 characters passes; one with a URL does not", () => {
      const long = "Add a route that answers ok to every request, with a unit test and an e2e test.";
      expect(publicText({ title: "Add a page", body: long }, sanitizer).body.ok).toBe(true);
      expect(publicText({ title: "Add a page", body: `${long}\nSee https://example.org` }, sanitizer).body).toEqual({ ok: false, violations: ["url"] });
    });
  });
});
