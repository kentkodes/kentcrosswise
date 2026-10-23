// P2-08 skeleton graph (DESIGN §4.3): one LangGraph thread per task (`task-<id>`), checkpointed in
// Postgres schema `lg`. Two nodes: `assign` marks the task as waiting on the Developer, then
// `await_report` interrupts until an agent report resumes it. The full state machine is P2-10.
import {
  Annotation,
  END,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import type { AgentReport } from "@kcw/core/events";

export type WaitingOn = "dev" | "ci" | "qa" | "owner" | "deploy";

/** What the graph exposes while it waits (the interrupt value). */
export interface WaitRequest {
  waiting_on: WaitingOn;
}

export const TaskState = Annotation.Root({
  task_id: Annotation<number>,
  status: Annotation<"waiting" | "done">,
  waiting_on: Annotation<WaitingOn | null>,
  /** Reports received so far (validated by the handler before they reach the graph). */
  reports: Annotation<AgentReport[]>({
    reducer: (acc, next) => acc.concat(next),
    default: () => [],
  }),
});

export type TaskStateValues = typeof TaskState.State;

export function buildGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(TaskState)
    .addNode("assign", () => ({ status: "waiting" as const, waiting_on: "dev" as const }))
    .addNode("await_report", (state) => {
      // Throws GraphInterrupt on the first run; on resume it returns the Command's resume value.
      // The node re-runs from the top on resume, so nothing before interrupt() may have side effects.
      const report = interrupt<WaitRequest, AgentReport>({ waiting_on: state.waiting_on ?? "dev" });
      return { reports: [report], status: "done" as const, waiting_on: null };
    })
    .addEdge(START, "assign")
    .addEdge("assign", "await_report")
    .addEdge("await_report", END)
    .compile({ checkpointer });
}

export type TaskGraph = ReturnType<typeof buildGraph>;
