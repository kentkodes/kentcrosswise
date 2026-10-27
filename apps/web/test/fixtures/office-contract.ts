// Entirely fictional transport examples. Fixed UUID-shaped values are test data,
// not an allocation strategy or evidence of random production identifiers.
import type { AvailableOffice, OfficeEvent, OfficeEnvelope, TaskRef, ExecutionRef, OfficePosition } from "../../src/office-contract";

export const REFS = {
  generation: "gen_f5938ea8-a1b3-4cb1-908a-bb9622ab540d",
  health: "task_355a7bfa-0a9b-432a-8c63-b13ea0f5d841",
  privateOne: "task_14ca6a28-ced0-48b0-b95b-7c5c0e551783",
  privateTwo: "task_83b722e7-06b1-4d44-9f06-07d9a9dc9e65",
  docs: "task_a34e2196-833e-4a98-91a3-d1d23db7c684",
  healthRun: "exec_a8362311-8f8e-4fab-9f4c-3905927bf36a",
  privateOneRun: "exec_887b5280-ef5a-475c-b557-ded5e238b57c",
  privateTwoRun: "exec_c12d4331-37c3-42e0-a894-96f235604315",
  docsRun: "exec_33f9dd70-858e-4d17-8ac7-e0819ae24ab5",
} as const;
const observedAt = "2026-10-25T18:30:00.000Z";
const recordedAt = "2026-10-25T18:20:00.000Z";
const from: OfficePosition = { revision: "9", ordinal: 0 };
const watermark: OfficePosition = { revision: "10", ordinal: 2 };
const event = (suffix: string, ordinal: number, task_ref: TaskRef, execution_ref: ExecutionRef, role: OfficeEvent["role"], type: OfficeEvent["type"], description: string, visibility: OfficeEvent["visibility"]): OfficeEvent => ({
  ref: `event_57e6faff-6aa4-4498-ae97-${suffix}`, position: { revision: "10", ordinal }, recorded_at: recordedAt, role, type, task_ref, execution_ref, visibility, description,
});
export function officeFixture(): AvailableOffice {
  return {
    version: 1, available: true, generation: REFS.generation, privacy_epoch: "2", observed_at: observedAt, revision: "10",
    snapshot: {
      tasks: [
        { ref: REFS.health, visibility: "public", description: "Add a health endpoint", kind: "work", state: "merged", waiting_on: null, paused: false, role: "qa", execution_ref: REFS.healthRun },
        { ref: REFS.privateOne, visibility: "private", description: "Private task", kind: "work", state: "merged", waiting_on: null, paused: null, role: "developer", execution_ref: REFS.privateOneRun },
        { ref: REFS.privateTwo, visibility: "private", description: "Private task", kind: "docs", state: "in_progress", waiting_on: null, paused: false, role: "docs", execution_ref: REFS.privateTwoRun },
        { ref: REFS.docs, visibility: "public", description: "Document the health endpoint", kind: "docs", state: "waiting", waiting_on: "dev", paused: false, role: "docs", execution_ref: REFS.docsRun },
      ],
      executions: [
        { ref: REFS.healthRun, task_ref: REFS.health, role: "qa", assignment: { station: "qa", seat: null }, phase: "terminal", outcome: "succeeded", observation: { source: "trusted_workflow", observed_at: recordedAt }, reported_activity: "merged", reported_at: recordedAt },
        { ref: REFS.privateOneRun, task_ref: REFS.privateOne, role: "developer", assignment: { station: "developer", seat: 1 }, phase: "unknown", outcome: null, observation: null, reported_activity: "coding", reported_at: recordedAt },
        { ref: REFS.privateTwoRun, task_ref: REFS.privateTwo, role: "docs", assignment: { station: "docs", seat: null }, phase: "running", outcome: null, observation: { source: "trusted_work_job", observed_at: recordedAt }, reported_activity: "coding", reported_at: recordedAt },
        { ref: REFS.docsRun, task_ref: REFS.docs, role: "docs", assignment: null, phase: "starting", outcome: null, observation: { source: "trusted_start_report", observed_at: recordedAt }, reported_activity: "coding", reported_at: recordedAt },
      ],
      related_tasks: [
        { task_ref: REFS.docs, related_task_ref: REFS.health, kind: "docs_parent", visibility: "public", description: "Add a health endpoint" },
        { task_ref: REFS.privateTwo, related_task_ref: REFS.privateOne, kind: "docs_parent", visibility: "private", description: "Private task" },
      ],
      pause: { paused: false, observed_at: observedAt },
    },
    events: [
      event("069bcfceda84", 0, REFS.privateOne, REFS.privateOneRun, "developer", "coding", "Private task", "private"),
      event("c9734ed1b8bc", 1, REFS.privateTwo, REFS.privateTwoRun, "docs", "coding", "Private task", "private"),
      event("5a048275c250", 2, REFS.health, REFS.healthRun, "qa", "merged", "Add a health endpoint", "public"),
    ],
    history: { mode: "incremental", generation: REFS.generation, privacy_epoch: "2", from: { ...from }, through: { ...watermark }, cursor: "cur_SyntheticBindingForTestsOnly_v1", watermark: { ...watermark }, oldest_available: { revision: "1", ordinal: 0 }, has_more: false, completeness: "complete", replay: null, gap: null, invalidations: [] },
    capabilities: { execution_observations: true, deployment_events: false, routing_events: false },
  };
}
export function bootstrapFixture(): AvailableOffice {
  const value = officeFixture();
  value.history.mode = "bootstrap";
  value.history.from = null;
  value.history.replay = { events: value.events, from: value.events[0]!.position, through: value.events.at(-1)!.position, completeness: "partial" };
  value.events = [];
  return value;
}
export function unavailableFixture(): OfficeEnvelope {
  return { version: 1, available: false, generation: null, privacy_epoch: null, observed_at: null, revision: null, snapshot: null, events: [], history: null, capabilities: null };
}
