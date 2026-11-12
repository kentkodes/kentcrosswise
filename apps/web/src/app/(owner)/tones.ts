// Status dot tones for the owner console. The word next to each dot carries the meaning; the tone is colour only.
export type Tone = "ok" | "warn" | "idle";

// Task statuses from packages/db/migrations/0002_agent_system.sql. An unknown status is idle.
export function taskTone(status: string): Tone {
  switch (status) {
    case "planning":
    case "in_progress":
    case "merged":
    case "done":
      return "ok";
    case "waiting":
    case "failed":
      return "warn";
    default:
      return "idle";
  }
}

// Approval statuses: pending waits on the owner, approved is ok, rejected is idle.
export function approvalTone(status: string): Tone {
  switch (status) {
    case "pending":
      return "warn";
    case "approved":
      return "ok";
    default:
      return "idle";
  }
}
