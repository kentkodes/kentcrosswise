// trackPlannerUsage: model usage attributed to the task of each planner call.
import { FakeProvider, type UsageRecord } from "@kcw/core/models";
import { describe, expect, it } from "vitest";
import { ModelPlanner, PLANNER_SYSTEM, trackPlannerUsage } from "../src/nodes";

const req = (task_id: number, owner_text = `task ${task_id}`) => ({ task_id, owner_text, is_private: true });

describe("trackPlannerUsage", () => {
  const setup = (delayMs = 0) => {
    const rows: [number, UsageRecord][] = [];
    const lines: string[] = [];
    const usage = trackPlannerUsage(async (id, u) => void rows.push([id, u]), (l) => lines.push(l));
    const provider = new FakeProvider({
      onUsage: usage.onUsage,
      complete: async (r) => {
        await new Promise((res) => setTimeout(res, delayMs));
        return { text: r.system === PLANNER_SYSTEM ? '{"subtasks": ["x"]}' : '{"title": "T", "body": "B"}' };
      },
    });
    return { rows, lines, provider, planner: usage.planner(new ModelPlanner({ provider })) };
  };

  it("records every call of both nodes with the request's task id, retries included", async () => {
    const { rows, planner, provider } = setup();
    await planner.split(req(3));
    await planner.plan(req(4));
    expect(rows.map(([id, u]) => [id, u.operation, u.provider])).toEqual([
      [3, "complete", "fake"],
      [4, "complete", "fake"],
    ]);
    expect(provider.calls).toHaveLength(2);
  });

  it("keeps concurrent calls apart", async () => {
    const { rows, planner } = setup(5);
    await Promise.all([planner.plan(req(1)), planner.split(req(2)), planner.plan(req(3))]);
    expect(rows.map(([id]) => id).sort()).toEqual([1, 2, 3]);
  });

  it("logs usage outside a planner call instead of attributing it to some task", async () => {
    const { rows, lines, provider } = setup();
    await provider.complete({ prompt: "hi" });
    expect(rows).toEqual([]);
    expect(lines).toEqual(["model usage outside a task (fake/fake-model-1): not recorded"]);
  });

  it("a failed usage write fails the node call", async () => {
    const usage = trackPlannerUsage(async () => {
      throw new Error("db down");
    });
    const provider = new FakeProvider({ onUsage: usage.onUsage, complete: { text: '{"subtasks": ["x"]}' } });
    await expect(usage.planner(new ModelPlanner({ provider })).split(req(1))).rejects.toThrow("db down");
  });
});
