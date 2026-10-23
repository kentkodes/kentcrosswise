import { describe, expect, it } from "vitest";
import {
  MERGE_INPUT_ARTIFACT,
  MERGE_INPUT_FILE,
  MergeInputFormatError,
  parseMergeInput,
  serializeMergeInput,
  type MergeInput,
} from "../src/merge-input/index";

const INPUT: MergeInput = {
  planSummary: {
    format: 1,
    infra: [{ address: "module.orchestrator.aws_sqs_queue.dlq", kind: "update", changed: ["message_retention_seconds"] }],
    artifact: { count: 3, kinds: { create: 1, update: 2, delete: 0, replace: 0 } },
  },
  lockDiff: { added: [{ importer: "agents/report", name: "zod" }], existing: ["pg", "vitest"] },
};

describe("merge-rules CI artifact contract", () => {
  it("names the artifact and its file", () => {
    expect(MERGE_INPUT_ARTIFACT).toBe("merge-rules-input");
    expect(MERGE_INPUT_FILE).toBe(`${MERGE_INPUT_ARTIFACT}.json`);
  });

  it("round-trips through serialize and parse", () => {
    const text = serializeMergeInput(INPUT);
    expect(JSON.parse(text)).toEqual({ format: 1, ...INPUT });
    expect(text.endsWith("}\n")).toBe(true);
    expect(parseMergeInput(text)).toEqual(INPUT);
  });

  it("drops unknown fields", () => {
    const text = JSON.stringify({
      format: 1,
      extra: true,
      planSummary: { ...INPUT.planSummary, note: "x" },
      lockDiff: { ...INPUT.lockDiff, other: 1 },
    });
    expect(parseMergeInput(text)).toEqual(INPUT);
  });

  const bad: [string, unknown][] = [
    ["format", { ...INPUT, format: 2 }],
    ["planSummary", { format: 1, lockDiff: INPUT.lockDiff }],
    ["planSummary format", { format: 1, planSummary: { ...INPUT.planSummary, format: 2 }, lockDiff: INPUT.lockDiff }],
    ["infra kind", { format: 1, planSummary: { ...INPUT.planSummary, infra: [{ address: "a", kind: "move", changed: [] }] }, lockDiff: INPUT.lockDiff }],
    ["artifact kinds", { format: 1, planSummary: { ...INPUT.planSummary, artifact: { count: 1, kinds: { create: 1 } } }, lockDiff: INPUT.lockDiff }],
    ["lockDiff", { format: 1, planSummary: INPUT.planSummary }],
    ["existing", { format: 1, planSummary: INPUT.planSummary, lockDiff: { added: [] } }],
    ["added entry", { format: 1, planSummary: INPUT.planSummary, lockDiff: { added: [{ importer: "." }], existing: [] } }],
  ];
  it.each(bad)("rejects a bad %s", (_label, value) => {
    expect(() => parseMergeInput(JSON.stringify(value))).toThrow(MergeInputFormatError);
  });

  it("rejects non-JSON without quoting it", () => {
    expect(() => parseMergeInput("not json {secret}")).toThrow(/not valid JSON$/);
  });
});
