import { describe, expect, it } from "vitest";
import {
  MERGE_INPUT_ARTIFACT,
  MERGE_INPUT_FILE,
  MergeInputFormatError,
  parseMergeInput,
  serializeMergeInput,
  type MergeInput,
} from "../src/merge-input/index";

const SHA = "a".repeat(40);
const INPUT: MergeInput = {
  pr: 42,
  headSha: SHA,
  planSummary: {
    format: 1,
    infra: [{ address: "module.orchestrator.aws_sqs_queue.dlq", kind: "update", changed: ["message_retention_seconds"] }],
    artifact: { count: 3, kinds: { create: 1, update: 2, delete: 0, replace: 0 } },
  },
  lockDiff: { added: [{ importer: "agents/report", name: "zod" }], existing: ["pg", "vitest"] },
  uncoveredPaths: [".github/workflows/ci.yml", "infra/preview/main.tf"],
};

describe("merge-rules CI artifact contract", () => {
  it("names the artifact and its file", () => {
    expect(MERGE_INPUT_ARTIFACT).toBe("merge-rules-input");
    expect(MERGE_INPUT_FILE).toBe(`${MERGE_INPUT_ARTIFACT}.json`);
  });

  it("round-trips through serialize and parse", () => {
    const text = serializeMergeInput(INPUT);
    expect(JSON.parse(text)).toEqual({ format: 2, ...INPUT });
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseMergeInput(text)).toEqual(INPUT);
  });

  it("drops unknown fields", () => {
    const text = JSON.stringify({
      format: 2,
      extra: true,
      pr: INPUT.pr,
      headSha: INPUT.headSha,
      uncoveredPaths: INPUT.uncoveredPaths,
      planSummary: { ...INPUT.planSummary, note: "x" },
      lockDiff: { ...INPUT.lockDiff, other: 1 },
    });
    expect(parseMergeInput(text)).toEqual(INPUT);
  });

  const ok = { format: 2, pr: 42, headSha: SHA, planSummary: INPUT.planSummary, lockDiff: INPUT.lockDiff, uncoveredPaths: [] };
  const bad: [string, unknown][] = [
    ["format 1", { ...ok, format: 1 }],
    ["format", { ...ok, format: 3 }],
    ["pr", { ...ok, pr: 0 }],
    ["headSha", { ...ok, headSha: "ABC" }],
    ["missing uncoveredPaths", { ...ok, uncoveredPaths: undefined }],
    ["uncoveredPaths entry", { ...ok, uncoveredPaths: [1] }],
    ["planSummary", { ...ok, planSummary: undefined }],
    ["planSummary format", { ...ok, planSummary: { ...INPUT.planSummary, format: 2 } }],
    ["infra kind", { ...ok, planSummary: { ...INPUT.planSummary, infra: [{ address: "a", kind: "move", changed: [] }] } }],
    ["artifact kinds", { ...ok, planSummary: { ...INPUT.planSummary, artifact: { count: 1, kinds: { create: 1 } } } }],
    ["lockDiff", { ...ok, lockDiff: undefined }],
    ["existing", { ...ok, lockDiff: { added: [] } }],
    ["added entry", { ...ok, lockDiff: { added: [{ importer: "." }], existing: [] } }],
  ];
  it.each(bad)("rejects a bad %s", (_label, value) => {
    expect(() => parseMergeInput(JSON.stringify(value))).toThrow(MergeInputFormatError);
  });

  it("rejects non-JSON without quoting it", () => {
    expect(() => parseMergeInput("not json {secret}")).toThrow(/not valid JSON$/);
  });
});
