// @kcw/orchestrator/graph (P2-10): the task graph, the PR loop of DESIGN §4.2-§4.3 on LangGraph.
//
// One thread per task (`task-<id>`, checkpointed in schema lg). Two nodes in a loop:
//   step: applies one input to the task's state machine (machine.ts): GitHub calls, DB writes;
//   wait: interrupt() until the next input (relay event, agent report, owner decision, sweep).
// The thread ends when the task is merged, failed or cancelled. A task the planner splits (P2-11)
// gets one child task and thread per subtask; the parent thread waits in phase `children`.
//
// src/lambda.ts runs it: `handleTaskSqsEvent` with `ModelPlanner` from `@kcw/orchestrator/nodes`.
import { Annotation, Command, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from "@langchain/langgraph";
import { handleRecords, threadConfig, type SqsBatchResponse, type SqsEvent } from "../handler";
import { runStep, type TaskGraphDeps } from "./machine";
import { parseTaskMessage } from "./messages";
import { initialTaskData, waitingOnOf, type Phase, type StepOutcome, type TaskData, type TaskInput, type WaitingOn } from "./types";

export * from "./types";
export { PgTaskStore, IN_FLIGHT_STATUSES, type ApprovalKind, type ApprovalRecord, type ChildTask, type TaskRecord, type TaskStatus, type TaskStore, type TaskUpdate } from "./store";
export { runStep, type TaskGraphDeps } from "./machine";
export { parseTaskMessage } from "./messages";

/** The interrupt value: what the thread waits for. */
export interface TaskWait {
  phase: Phase;
  waiting_on: WaitingOn | null;
}

export const TaskGraphState = Annotation.Root({
  task_id: Annotation<number>,
  /** The input being applied (set by `wait`, consumed by `step`). */
  input: Annotation<TaskInput | null>,
  task: Annotation<TaskData>,
});

export type TaskGraphStateValues = typeof TaskGraphState.State;

export function buildTaskGraph(checkpointer: BaseCheckpointSaver, deps: TaskGraphDeps) {
  return new StateGraph(TaskGraphState)
    .addNode("step", async (s) => ({
      task: await runStep(s.task_id, s.task ?? initialTaskData(), s.input!, deps),
      input: null,
    }))
    .addNode("wait", (s) => {
      // On resume this node re-runs and interrupt() returns the Command's resume value; nothing
      // before it has side effects.
      const input = interrupt<TaskWait, TaskInput>({ phase: s.task.phase, waiting_on: waitingOnOf(s.task.phase) });
      return { input };
    })
    .addEdge(START, "step")
    .addConditionalEdges("step", (s) => (s.task.phase === "done" ? END : "wait"), ["wait", END])
    .addEdge("wait", "step")
    .compile({ checkpointer });
}

export type TaskGraph = ReturnType<typeof buildTaskGraph>;

export type TaskOutcome =
  | StepOutcome
  | "started" // new thread, ran to its first wait
  | "duplicate_start" // task.created for an existing thread
  | "duplicate" // a redelivered message that was already applied
  | "recovered" // a step that failed earlier was completed (this message was its input)
  | "no_thread" // input for a task that has no thread
  | "finished"; // input for a thread that has ended

/**
 * Runs one input on the task's thread. A thread whose last step failed (GitHub or DB error) is
 * first completed with the input it already holds; the failed message comes back from SQS with the
 * same message id and is then recognised as applied.
 *
 * If the task is split into subtasks, every child thread that has not started (or whose start
 * failed half-way) is then started here, so a redelivery or a sweep of the parent completes it.
 * The same holds for the docs task of a merged task (§4.2 step 8).
 */
export async function processTaskInput(graph: TaskGraph, taskId: number, input: TaskInput): Promise<TaskOutcome> {
  const outcome = await applyTaskInput(graph, taskId, input);
  if (outcome !== "no_thread") {
    await startSubtasks(graph, taskId, input.message_id);
    await startDocsTask(graph, taskId, input.message_id);
  }
  return outcome;
}

async function startDocsTask(graph: TaskGraph, taskId: number, messageId: string): Promise<void> {
  const task = (await graph.getState(threadConfig(taskId))).values.task;
  if (task?.phase !== "done" || typeof task.docs_task !== "number" || task.pr_number === null) return;
  // A started docs thread answers duplicate_start; a docs task never gets a docs task, so this never recurses further.
  await processTaskInput(graph, task.docs_task, {
    kind: "start",
    docs: { pr: task.pr_number },
    message_id: `${messageId}/docs-${task.docs_task}`,
  });
}

async function startSubtasks(graph: TaskGraph, taskId: number, messageId: string): Promise<void> {
  const task = (await graph.getState(threadConfig(taskId))).values.task;
  if (task?.phase !== "children") return;
  // A started child answers duplicate_start (no write); a child never splits, so this never recurses further.
  for (const child of task.children) {
    await processTaskInput(graph, child, { kind: "start", message_id: `${messageId}/task-${child}` });
  }
}

async function applyTaskInput(graph: TaskGraph, taskId: number, input: TaskInput): Promise<TaskOutcome> {
  const config = threadConfig(taskId);
  let snapshot = await graph.getState(config);
  const exists = snapshot.config.configurable?.checkpoint_id !== undefined;

  if (!exists) {
    if (input.kind !== "start") return "no_thread";
    await graph.invoke({ task_id: taskId, input, task: initialTaskData() }, config);
    const outcome = (await graph.getState(config)).values.task?.last_outcome;
    return outcome === "applied" ? "started" : (outcome ?? "started");
  }

  const interrupted = () => snapshot.tasks.some((t) => t.interrupts.length > 0);
  if (!interrupted() && snapshot.next.length > 0) {
    await graph.invoke(null, config);
    snapshot = await graph.getState(config);
    if (snapshot.values.task?.last_message_id === input.message_id) return "recovered";
  }
  if (input.kind === "start") return "duplicate_start";
  // A final workflow report can arrive after the approving webhook ended the thread. Run it
  // through the same checkpointed step with the completed state: Machine.report records usage
  // without changing the lifecycle, and the step returns to END. Other late inputs stay ignored.
  const terminalReport = !interrupted() && input.kind === "report" && snapshot.values.task?.phase === "done";
  if (!interrupted() && !terminalReport) return "finished";
  if (snapshot.values.task?.last_message_id === input.message_id) return "duplicate";

  await graph.invoke(
    terminalReport ? { task_id: taskId, input, task: snapshot.values.task } : new Command({ resume: input }),
    config,
  );
  return (await graph.getState(config)).values.task?.last_outcome ?? "applied";
}

export interface TaskHandlerDeps {
  graph: TaskGraph;
  /** One line per message (and per notable step); never message bodies or task text. */
  log?: (line: string) => void;
}

/** SQS handler for the task graph (batch semantics: `handleRecords`). */
export async function handleTaskSqsEvent(event: SqsEvent, deps: TaskHandlerDeps): Promise<SqsBatchResponse> {
  return handleRecords(
    event,
    async (record) => {
      const { task_id, input } = parseTaskMessage(record.body, record.attributes?.MessageGroupId, record.messageId);
      return processTaskInput(deps.graph, task_id, input);
    },
    deps.log,
  );
}
