import { describe, expect, it } from "vitest";
import { OFFICE_LIMITS, compareOfficePositions, parseOfficeEnvelope } from "../src/office-contract";
import type { AvailableOffice, OfficeValidationCode } from "../src/office-contract";
import { REFS, bootstrapFixture, officeFixture, unavailableFixture } from "./fixtures/office-contract";

function rejected(edit: (value: AvailableOffice) => void, code?: OfficeValidationCode) {
  const value = officeFixture();
  edit(value);
  const result = parseOfficeEnvelope(value);
  expect(result.ok).toBe(false);
  if (code) expect(result).toEqual({ ok: false, code });
  return result;
}

describe("local office transport contract", () => {
  it("returns an independent typed copy and preserves two distinct private histories, parent labels and unknown execution", () => {
    const input = officeFixture();
    const result = parseOfficeEnvelope(input);
    expect(result).toEqual({ ok: true, value: input });
    if (!result.ok || !result.value.available) throw new Error("Expected available fixture");
    expect(result.value.events[0]!.description).toBe("Private task");
    expect(result.value.events[1]!.description).toBe("Private task");
    expect(result.value.events[0]!.task_ref).not.toBe(result.value.events[1]!.task_ref);
    expect(result.value.snapshot.executions![1]).toMatchObject({ phase: "unknown", observation: null, reported_activity: "coding" });
    expect(result.value.snapshot.executions![0]).toMatchObject({ phase: "terminal", outcome: "succeeded" });
    expect(result.value.snapshot.related_tasks![1]!.description).toBe("Private task");
    input.snapshot.tasks![0]!.description = "Changed fixture";
    input.events[0]!.position.ordinal = 40;
    expect(result.value.snapshot.tasks![0]!.description).toBe("Add a health endpoint");
    expect(result.value.events[0]!.position.ordinal).toBe(0);
  });
  it("keeps failed availability content-free and distinct from authoritative empty or unknown state", () => {
    expect(parseOfficeEnvelope(unavailableFixture())).toEqual({ ok: true, value: unavailableFixture() });
    const bad = { ...unavailableFixture(), snapshot: { tasks: [] } };
    expect(parseOfficeEnvelope(bad)).toEqual({ ok: false, code: "metadata" });
    expect(parseOfficeEnvelope({ ...unavailableFixture(), message: "Synthetic database diagnostic" })).toEqual({ ok: false, code: "shape" });
    const unknown = officeFixture();
    unknown.snapshot = { tasks: null, executions: null, related_tasks: null, pause: { paused: null, observed_at: null } };
    unknown.events = []; unknown.history.mode = "state"; unknown.history.from = null; unknown.history.through = null; unknown.history.cursor = null;
    expect(parseOfficeEnvelope(unknown)).toEqual({ ok: true, value: unknown });
  });
  it("accepts a separate partial latest-history replay and an incremental page split within one revision", () => {
    const bootstrap = bootstrapFixture();
    expect(parseOfficeEnvelope(bootstrap)).toEqual({ ok: true, value: bootstrap });
    const firstPage = officeFixture();
    firstPage.events = firstPage.events.slice(0, 1);
    firstPage.history.through = { revision: "10", ordinal: 0 }; firstPage.history.has_more = true;
    expect(parseOfficeEnvelope(firstPage)).toEqual({ ok: true, value: firstPage });
    const secondPage = officeFixture();
    secondPage.events = secondPage.events.slice(1); secondPage.history.from = { revision: "10", ordinal: 0 };
    expect(parseOfficeEnvelope(secondPage)).toEqual({ ok: true, value: secondPage });
    expect(compareOfficePositions({ revision: "9007199254740993", ordinal: 0 }, { revision: "9007199254740992", ordinal: OFFICE_LIMITS.ordinal })).toBe(1);
  });
  it("rejects extra fields at every nested boundary instead of copying raw/private content", () => {
    const targets: ((v: AvailableOffice) => object)[] = [
      (v) => v, (v) => v.snapshot, (v) => v.snapshot.pause, (v) => v.snapshot.tasks![0]!,
      (v) => v.snapshot.executions![0]!, (v) => v.snapshot.executions![0]!.assignment!, (v) => v.snapshot.executions![0]!.observation!,
      (v) => v.snapshot.related_tasks![0]!, (v) => v.events[0]!, (v) => v.events[0]!.position,
      (v) => v.history, (v) => v.history.watermark, (v) => v.history.from!, (v) => v.capabilities,
    ];
    for (const target of targets) rejected((v) => { Object.assign(target(v), { owner_text: "Synthetic private fixture text" }); }, "shape");
    const replay = bootstrapFixture();
    Object.assign(replay.history.replay!, { detail: "Synthetic private fixture text" });
    expect(parseOfficeEnvelope(replay)).toEqual({ ok: false, code: "shape" });
    rejected((v) => { v.history.invalidations = [{ task_ref: REFS.privateOne, kind: "redact" }]; Object.assign(v.history.invalidations[0]!, { raw_id: 101 }); }, "shape");
    rejected((v) => { v.history.gap = { reason: "privacy_changed", from: null, through: null, recovery: "rebind" }; Object.assign(v.history.gap, { detail: "Synthetic detail" }); }, "shape");
  });
  it("requires exactly the generic description in private tasks, events and related work", () => {
    rejected((v) => { v.snapshot.tasks![1]!.description = "Private task: extra detail"; }, "privacy");
    rejected((v) => { v.events[0]!.description = "Synthetic private request"; }, "privacy");
    rejected((v) => { v.snapshot.related_tasks![1]!.description = "Former public title"; }, "privacy");
    rejected((v) => { v.events[0]!.visibility = "public"; v.events[0]!.description = "Former public title"; }, "privacy");
  });
  it("enforces redaction and consistent relation/event labels even when the task inventory is withheld", () => {
    rejected((v) => {
      v.snapshot.tasks = null;
      v.snapshot.related_tasks![1]!.visibility = "public";
      v.snapshot.related_tasks![1]!.description = "Former public title";
      v.history.invalidations = [{ task_ref: REFS.privateOne, kind: "redact" }];
    }, "privacy");
    rejected((v) => {
      v.snapshot.tasks = null;
      v.events[0]!.visibility = "public"; v.events[0]!.description = "Former public title";
    }, "privacy");
    const redacted = officeFixture(); redacted.snapshot.tasks = null;
    redacted.history.invalidations = [{ task_ref: REFS.privateOne, kind: "redact" }];
    expect(parseOfficeEnvelope(redacted)).toEqual({ ok: true, value: redacted });
  });
  it("keeps redact private-only and requires the current public row for a relabel", () => {
    // redact: the task must be private now, with or without an inventory (defence in depth).
    rejected((v) => { v.history.invalidations = [{ task_ref: REFS.health, kind: "redact" }]; }, "privacy");
    rejected((v) => { v.snapshot.tasks = null; v.history.invalidations = [{ task_ref: REFS.health, kind: "redact" }]; }, "privacy");
    const redacted = officeFixture();
    redacted.history.invalidations = [{ task_ref: REFS.privateOne, kind: "redact" }];
    expect(parseOfficeEnvelope(redacted)).toEqual({ ok: true, value: redacted });
    // relabel: retitle/republish; the current public row is the only label allowed.
    const relabelled = officeFixture();
    relabelled.history.invalidations = [{ task_ref: REFS.health, kind: "relabel" }];
    expect(parseOfficeEnvelope(relabelled)).toEqual({ ok: true, value: relabelled });
    rejected((v) => { v.history.invalidations = [{ task_ref: REFS.privateOne, kind: "relabel" }]; }, "privacy");
    rejected((v) => { v.history.invalidations = [{ task_ref: "task_0b6d6f53-6a3f-4c1e-9d55-1f7e8a2b3c4d", kind: "relabel" }]; }, "association");
    rejected((v) => { v.snapshot.tasks = null; v.history.invalidations = [{ task_ref: REFS.health, kind: "relabel" }]; }, "association");
    rejected((v) => { v.history.invalidations = [{ task_ref: REFS.health, kind: "relabel" }]; v.events[2]!.description = "Old public title"; }, "privacy");
  });
  it("rejects raw IDs, unsupported versions and fake event types while accepting paused/cancelled state facts", () => {
    for (const raw of ["101", "task-101", "task_101", "task_00000000-0000-0000-0000-000000000101", 101]) {
      rejected((v) => { Object.assign(v.snapshot.tasks![0]!, { ref: raw }); }, "reference");
      rejected((v) => { Object.assign(v.events[0]!, { ref: raw }); }, "reference");
      rejected((v) => { Object.assign(v.snapshot.executions![0]!, { ref: raw }); }, "reference");
    }
    rejected((v) => { v.history.cursor = "102"; }, "reference");
    rejected((v) => { Object.assign(v, { version: 2 }); }, "version");
    for (const type of ["paused", "cancelled", "model_running"]) rejected((v) => { Object.assign(v.events[0]!, { type }); }, "shape");
    const state = officeFixture(); state.snapshot.tasks![1]!.paused = true; state.snapshot.tasks![1]!.state = "cancelled";
    expect(parseOfficeEnvelope(state)).toEqual({ ok: true, value: state });
  });
  it("validates real UTC timestamps and forbids observations later than the envelope observation", () => {
    for (const recorded_at of ["2026-02-30T18:20:00.000Z", "2026-10-25", "2026-10-25T18:20:00+00:00", "not a date", "2026-10-25T18:31:00.000Z"]) {
      rejected((v) => { v.events[0]!.recorded_at = recorded_at; }, "timestamp");
    }
    rejected((v) => { v.snapshot.executions![0]!.observation!.observed_at = "2026-10-25T18:31:00.000Z"; }, "timestamp");
    rejected((v) => { v.snapshot.pause.observed_at = "2026-10-25T18:31:00.000Z"; }, "timestamp");
  });
  it("bounds descriptions, all collection sizes, cursor bytes and exact position components", () => {
    rejected((v) => { v.events[2]!.description = "x".repeat(61); }, "limit");
    rejected((v) => { v.snapshot.tasks![0]!.description = "bad\nlabel"; }, "privacy");
    rejected((v) => { v.events = Array(51).fill(v.events[0]); }, "limit");
    rejected((v) => { v.snapshot.tasks = Array(257).fill(v.snapshot.tasks![0]); }, "limit");
    rejected((v) => { v.snapshot.executions = Array(257).fill(v.snapshot.executions![0]); }, "limit");
    rejected((v) => { v.snapshot.related_tasks = Array(257).fill(v.snapshot.related_tasks![0]); }, "limit");
    rejected((v) => { v.history.invalidations = Array(257).fill({ task_ref: REFS.privateOne, kind: "redact" }); }, "limit");
    const replay = bootstrapFixture(); replay.history.replay!.events = Array(21).fill(replay.history.replay!.events[0]);
    expect(parseOfficeEnvelope(replay)).toEqual({ ok: false, code: "limit" });
    rejected((v) => { v.history.cursor = `cur_${"x".repeat(509)}`; }, "reference");
    for (const revision of ["01", "1.0", "-1", "1e3", "9".repeat(21)]) rejected((v) => { v.events[0]!.position.revision = revision; }, "position");
    rejected((v) => { v.events[0]!.position.ordinal = OFFICE_LIMITS.ordinal + 1; }, "limit");
  });
  it("rejects incorrect task/execution/role associations, including withheld inventories", () => {
    rejected((v) => { v.events[0]!.execution_ref = REFS.privateTwoRun; }, "association");
    rejected((v) => { v.snapshot.tasks![1]!.execution_ref = REFS.privateTwoRun; }, "association");
    rejected((v) => { v.snapshot.executions![1]!.task_ref = REFS.privateTwo; }, "association");
    rejected((v) => { v.events[0]!.task_ref = null; }, "association");
    rejected((v) => { v.snapshot.related_tasks![1]!.related_task_ref = REFS.privateTwo; }, "association");
    rejected((v) => { v.snapshot.tasks = null; v.snapshot.executions = null; v.events[1]!.execution_ref = REFS.privateOneRun; }, "association");
    rejected((v) => { v.snapshot.executions = null; v.events[1]!.execution_ref = REFS.privateOneRun; }, "association");
    rejected((v) => { v.snapshot.tasks = null; v.snapshot.executions = null; v.events[1]!.task_ref = REFS.privateOne; v.events[1]!.execution_ref = REFS.privateOneRun; }, "association");
  });
  it("rejects duplicate entity refs, event refs, event positions, invalidation refs and relation entries", () => {
    rejected((v) => { v.snapshot.tasks!.push({ ...v.snapshot.tasks![0]! }); }, "duplicate");
    rejected((v) => { v.snapshot.executions!.push({ ...v.snapshot.executions![0]! }); }, "duplicate");
    rejected((v) => { v.events[1]!.ref = v.events[0]!.ref; }, "duplicate");
    rejected((v) => { v.events[1]!.position = { ...v.events[0]!.position }; }, "duplicate");
    rejected((v) => { v.snapshot.related_tasks!.push({ ...v.snapshot.related_tasks![0]! }); }, "duplicate");
    rejected((v) => { v.history.invalidations = Array(2).fill({ task_ref: REFS.privateOne, kind: "redact" }); }, "duplicate");
  });
  it("validates cursor generation/epoch binding metadata and never advances to undelivered snapshot positions", () => {
    rejected((v) => { v.history.privacy_epoch = "1"; }, "metadata");
    rejected((v) => { v.history.generation = "gen_060b7e49-cd6e-4cc3-b6cf-958ec040fb19"; }, "metadata");
    rejected((v) => { v.history.watermark.revision = "11"; }, "metadata");
    rejected((v) => { v.history.through = { revision: "10", ordinal: 3 }; }, "metadata");
    rejected((v) => { v.history.has_more = true; }, "metadata");
    rejected((v) => { v.history.from = { revision: "10", ordinal: 1 }; }, "position");
    rejected((v) => { v.events.reverse(); }, "position");
    rejected((v) => { v.history.oldest_available = { revision: "11", ordinal: 0 }; }, "position");
  });
  it("does not turn startup activity into running/terminal execution or unsupported deployed facts", () => {
    rejected((v) => { v.snapshot.executions![1]!.phase = "running"; }, "association");
    rejected((v) => { v.snapshot.executions![3]!.phase = "running"; }, "association");
    rejected((v) => { v.snapshot.executions![1]!.outcome = "succeeded"; }, "association");
    rejected((v) => { v.capabilities.execution_observations = false; }, "association");
    rejected((v) => { v.events[2]!.type = "deployed"; }, "association");
    rejected((v) => { v.snapshot.executions![1]!.assignment!.station = "qa"; }, "association");
  });
  it("requires explicit content-free gap recovery and rejects descriptions accompanying a tombstone", () => {
    const value = officeFixture();
    value.events = []; value.history.through = null; value.history.cursor = null;
    value.history.completeness = "gap";
    value.history.gap = { reason: "privacy_changed", from: { revision: "8", ordinal: 0 }, through: { revision: "9", ordinal: 0 }, recovery: "rebind" };
    expect(parseOfficeEnvelope(value)).toEqual({ ok: true, value });
    value.history.cursor = "cur_SyntheticOldBindingWouldBeInvalid";
    expect(parseOfficeEnvelope(value)).toEqual({ ok: false, code: "metadata" });
    rejected((v) => { v.history.invalidations = [{ task_ref: REFS.privateOne, kind: "delete" }]; }, "association");
  });
  it("never echoes unsafe property names, thrown messages, getters or custom objects", () => {
    const getter = officeFixture();
    Object.defineProperty(getter, "events", { enumerable: true, get: () => { throw new Error("Synthetic private error content"); } });
    expect(parseOfficeEnvelope(getter)).toEqual({ ok: false, code: "shape" });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("Synthetic private error content"); } });
    expect(parseOfficeEnvelope(proxy)).toEqual({ ok: false, code: "shape" });
    expect(parseOfficeEnvelope(new Date())).toEqual({ ok: false, code: "shape" });
    const array = officeFixture(); Object.assign(array.events, { secret_field: "Synthetic private value" });
    expect(parseOfficeEnvelope(array)).toEqual({ ok: false, code: "shape" });
  });
});
