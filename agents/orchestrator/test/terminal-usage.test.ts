// Reproduce final QA usage arriving after its approval has already caused the task to merge.
// The real graph/checkpointer seam runs entirely in memory: no DB, network or model calls.
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { FakeGitHubClient } from "../src/github";
import { buildTaskGraph, initialTaskData, processTaskInput, type TaskInput, type TaskStatus, type TaskStore, type TaskUpdate } from "../src/graph";
import { threadConfig } from "../src/handler";

describe("terminal task usage", () => {
  it("records a final QA usage report after the approved task has merged", async () => {
    const taskId = 1;
    const head = "a".repeat(40);
    let status = "queued";
    const addUsage = vi.fn<TaskStore["addUsage"]>().mockResolvedValue(undefined);
    const store: TaskStore = {
      getTask: async () => ({ id: taskId, status: "queued", owner_text: "Add a healthz page", is_private: false, github_issue: null, parent_id: null }),
      isPaused: async () => false,
      claimSlot: async () => true,
      updateTask: async (id: number, fields: TaskUpdate) => { if (id === taskId && fields.status) status = fields.status; },
      addEvent: async () => undefined,
      addUsage,
      createApproval: async () => { throw new Error("unexpected owner approval"); },
      getApproval: async () => null,
      supersedeApproval: async () => undefined,
      loadContacts: async () => [],
      createSubtasks: async () => { throw new Error("unexpected split"); },
      getChildren: async () => [],
      createDocsTask: async () => 2, // the merge creates the docs child (its own thread)
    };
    const github = new FakeGitHubClient();
    github.prs.set(41, { headSha: head, author: "developer[bot]", files: [{ path: "apps/web/src/app/healthz/route.ts", status: "added" }] });
    github.artifacts.set(head, {
      planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } },
      lockDiff: { added: [], existing: [] },
    });
    const graph = buildTaskGraph(new MemorySaver(), {
      github, store, now: () => new Date("2026-10-23T10:00:00Z"),
      planner: { split: async (req) => [req.owner_text], plan: async () => ({ title: "Add a healthz page", body: "Return ok from a healthz route." }) },
    });
    expect(await processTaskInput(graph, taskId, { kind: "start", message_id: "start" })).toBe("started");
    await processTaskInput(graph, taskId, { kind: "github", event: "pull_request", action: "opened", pr_number: 41, head_ref: "kcw/task-1", head_sha: head, merged: false, message_id: "opened" });
    await processTaskInput(graph, taskId, { kind: "github", event: "workflow_run", action: "completed", run_id: 10, workflow_path: ".github/workflows/ci.yml", conclusion: "success", trigger: "pull_request", head_sha: head, pr_numbers: [41], message_id: "ci" });
    await processTaskInput(graph, taskId, { kind: "github", event: "pull_request_review", action: "submitted", pr_number: 41, review_state: "approved", commit_id: head, message_id: "approval" });
    expect(status).toBe("merged");
    expect(github.merges).toHaveLength(1);
    expect((await graph.getState(threadConfig(taskId))).next).toEqual([]);

    const usage = [{ kind: "model" as const, provider: "anthropic", model: "synthetic-review-model", input_tokens: 100, output_tokens: 20 }];
    await processTaskInput(graph, taskId, { kind: "report", message_id: "qa-final-report", report: { task_id: taskId, agent: "qa", event_type: "qa_reviewing", usage } });
    expect(addUsage).toHaveBeenCalledExactlyOnceWith(taskId, "qa", usage);
  });
});

const usage = [{ kind: "model" as const, provider: "anthropic", model: "synthetic-review-model", input_tokens: 100, output_tokens: 20 }];
const finalReport = (messageId = "late-report"): Extract<TaskInput, { kind: "report" }> => ({
  kind: "report", message_id: messageId,
  report: { task_id: 1, agent: "qa", event_type: "qa_reviewing", usage },
});

function fixture(initialStatus: TaskStatus = "queued") {
  let status = initialStatus;
  const store: TaskStore = {
    getTask: async () => ({ id: 1, status, owner_text: "Add a healthz page", is_private: false, github_issue: null, parent_id: null }),
    isPaused: async () => false,
    claimSlot: async () => true,
    updateTask: vi.fn(async (_id: number, fields: TaskUpdate) => { if (fields.status) status = fields.status; }),
    addEvent: vi.fn<TaskStore["addEvent"]>().mockResolvedValue(undefined),
    addUsage: vi.fn<TaskStore["addUsage"]>().mockResolvedValue(undefined),
    createApproval: async () => { throw new Error("unexpected owner approval"); },
    getApproval: async () => null,
    supersedeApproval: async () => undefined,
    loadContacts: async () => [],
    createSubtasks: async () => { throw new Error("unexpected split"); },
    getChildren: async () => [],
    createDocsTask: async () => { throw new Error("unexpected docs task"); },
  };
  const github = new FakeGitHubClient();
  const saver = new MemorySaver();
  const deps = {
    github, store,
    planner: {
      split: async (req: { owner_text: string }) => [req.owner_text],
      plan: async () => ({ title: "Add a healthz page", body: "Return ok from a healthz route." }),
    },
  };
  const graph = buildTaskGraph(saver, deps);
  return { graph, github, store, status: () => status, freshGraph: () => buildTaskGraph(saver, deps) };
}

/** Seed an ended checkpoint for each terminal DB status; the PR-loop test above ends naturally. */
async function terminal(status: TaskStatus = "merged") {
  const f = fixture(status);
  await f.graph.invoke({
    task_id: 1, task: { ...initialTaskData(), phase: "done" },
    input: { kind: "sweep", message_id: "ended" },
  }, threadConfig(1));
  return f;
}

describe("reports on ended checkpoints", () => {
  it.each(["merged", "failed", "cancelled"] as const)("records late usage while preserving %s and END", async (status) => {
    const f = await terminal(status);
    expect(await processTaskInput(f.graph, 1, finalReport())).toBe("stale");
    expect(f.store.addUsage).toHaveBeenCalledExactlyOnceWith(1, "qa", usage);
    const snapshot = await f.graph.getState(threadConfig(1));
    expect(snapshot.values.task.phase).toBe("done");
    expect(snapshot.next).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(f.status()).toBe(status);
    expect(f.store.updateTask).not.toHaveBeenCalled();
    expect(f.store.addEvent).not.toHaveBeenCalled();
    expect(f.github.calls).toEqual([]);
  });

  it("does not record the immediate redelivery twice, including after a fresh graph instance", async () => {
    const f = await terminal();
    await processTaskInput(f.graph, 1, finalReport());
    expect(await processTaskInput(f.freshGraph(), 1, finalReport())).toBe("duplicate");
    expect(f.store.addUsage).toHaveBeenCalledTimes(1);
  });

  it("recovers a failed usage write through the pending checkpoint before deduplicating", async () => {
    const f = await terminal();
    vi.mocked(f.store.addUsage).mockRejectedValueOnce(new Error("synthetic write failure"));
    await expect(processTaskInput(f.graph, 1, finalReport())).rejects.toThrow("synthetic write failure");
    expect((await f.graph.getState(threadConfig(1))).next).toEqual(["step"]);
    const restarted = f.freshGraph();
    expect(await processTaskInput(restarted, 1, finalReport())).toBe("recovered");
    expect(await processTaskInput(restarted, 1, finalReport())).toBe("duplicate");
    expect(f.store.addUsage).toHaveBeenCalledTimes(2); // failed attempt, then successful write
    expect((await restarted.getState(threadConfig(1))).next).toEqual([]);
    expect(f.status()).toBe("merged");
    expect(f.store.updateTask).not.toHaveBeenCalled();
    expect(f.store.addEvent).not.toHaveBeenCalled();
    expect(f.github.calls).toEqual([]);
  });

  it("keeps late lifecycle inputs finished and unknown report threads absent", async () => {
    const f = await terminal();
    const inputs: TaskInput[] = [
      { kind: "sweep", message_id: "sweep" },
      { kind: "decision", approval_id: "synthetic-approval", decision: "approved", message_id: "decision" },
      { kind: "github", event: "pull_request_review", action: "submitted", pr_number: 41,
        review_state: "approved", commit_id: "a".repeat(40), message_id: "late-approval" },
    ];
    for (const input of inputs) expect(await processTaskInput(f.graph, 1, input)).toBe("finished");
    expect(await processTaskInput(f.graph, 1, { kind: "start", message_id: "start-again" })).toBe("duplicate_start");
    expect(await processTaskInput(f.graph, 2, { ...finalReport(), report: { ...finalReport().report, task_id: 2 } })).toBe("no_thread");
    expect(f.store.addUsage).not.toHaveBeenCalled();
    expect(f.store.addEvent).not.toHaveBeenCalled();
    expect(f.store.updateTask).not.toHaveBeenCalled();
    expect(f.github.calls).toEqual([]);
  });

  it("still records expected-agent reports and events on an interrupted preterminal thread", async () => {
    const f = fixture();
    await processTaskInput(f.graph, 1, { kind: "start", message_id: "start" });
    vi.mocked(f.store.addEvent).mockClear();
    expect(await processTaskInput(f.graph, 1, {
      kind: "report", message_id: "developer-progress",
      report: { task_id: 1, agent: "developer", event_type: "coding", usage },
    })).toBe("applied");
    expect(f.store.addUsage).toHaveBeenCalledExactlyOnceWith(1, "developer", usage);
    expect(f.store.addEvent).toHaveBeenCalledExactlyOnceWith(1, "developer", "coding", { source: "report" });
    const snapshot = await f.graph.getState(threadConfig(1));
    expect(snapshot.values.task.phase).toBe("dev");
    expect(snapshot.tasks.some((task) => task.interrupts.length > 0)).toBe(true);
    expect(f.status()).toBe("waiting");
  });
});
