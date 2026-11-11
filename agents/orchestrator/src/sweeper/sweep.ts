// One sweeper run (DESIGN §4.3, P2-17). Independent parts; one failing does not stop the others.
// A failed spend read or flag write blocks only the sweep-driven dispatch (the tasks part) and is
// reported as a failed part; it never sets the flag. Webhook-driven inputs are gated solely by
// agents_paused. The report names failed parts by error class; the log line adds the error chain
// (errors.ts describeError: classes, statuses, shortened messages with credentials redacted).
//   spend:      month-to-date model cost (spend.ts). At or above SPEND_CAP_USD: set agents_paused
//               (never cleared automatically), log spend_cap_reached, and dispatch nothing this run;
//   tasks:      a sweep message per waiting/queued task (the graph decides timeouts and retries);
//   pause:      if agents_paused, cancel agent workflow runs that have not completed;
//   gc:         in the nightly window, dispatch preview-gc.yml unless already dispatched;
//   redeliver:  redeliver failed webhook deliveries of the orchestrator App.
// Every part is safe to repeat for the same scheduled time (retried invocation).
import { threadIdOf } from "@kcw/core/events";
import { describeError } from "./errors";
import { REDELIVERY_DEFAULTS, selectRedeliveries, type RedeliveryPlan } from "./deliveries";
import { PREVIEW_GC_WORKFLOW, type SweeperGitHub } from "./github";
import { nightlyGcWindow, sweepDedupeId, windowLabel, windowStart } from "./schedule";
import { MAX_SWEEP_TASKS, type SweeperStore } from "./store";
import { SPEND_CAP_USD, capReached, monthToDateSpend, utcMonth } from "./spend";

/** The sweep message (P2-10 contract, parsed by graph/messages.ts). */
export interface SweepMessage {
  type: "sweep";
  task_id: number;
  thread_id: string;
}

/** One SQS FIFO SendMessage. */
export interface QueuedMessage {
  body: string;
  groupId: string;
  dedupeId: string;
}

export interface SweepQueue {
  send(message: QueuedMessage): Promise<void>;
}

/** The pieces a run uses. `github` is a function so missing App credentials fail only the GitHub parts. */
export interface SweepDeps {
  store: SweeperStore;
  queue: SweepQueue;
  github: () => Promise<SweeperGitHub>;
  /** The run's scheduled time (schedule.ts scheduledTimeOf). */
  scheduledTime: Date;
  /** Wall clock, for the delivery lookback. */
  now: Date;
  log?: (line: string) => void;
}

export type PartName = "spend" | "tasks" | "pause" | "gc" | "redeliver";

export interface SweepReport {
  window: string;
  /** Month-to-date model spend (UTC month); null when the spend check failed. */
  spend: { month: string; spentUsd: number; unpricedEvents: number } | null;
  /** True when the cap was reached in this run (agents_paused is set; no sweep messages sent). */
  capReached: boolean;
  /** Sweep messages sent. */
  swept: number;
  paused: boolean | null;
  cancelled: number;
  gc: "dispatched" | "already_dispatched" | "outside_window" | null;
  redelivered: number;
  redeliverySkipped: RedeliveryPlan["skipped"] | null;
  /** Failed parts with the error class. */
  failed: Partial<Record<PartName, string>>;
}

const errName = (err: unknown) => (err instanceof Error ? err.name : "error");

export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const window = windowStart(deps.scheduledTime);
  const report: SweepReport = {
    window: windowLabel(window),
    spend: null,
    capReached: false,
    swept: 0,
    paused: null,
    cancelled: 0,
    gc: null,
    redelivered: 0,
    redeliverySkipped: null,
    failed: {},
  };

  let github: Promise<SweeperGitHub> | undefined;
  const gh = () => (github ??= deps.github());

  const part = async (name: PartName, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      report.failed[name] = errName(err);
      log(`sweeper: ${name} failed (${errName(err)}) ${describeError(err)}`);
    }
  };

  // Set only when the spend check succeeded and the cap is not reached. Without it, no agent work is sent.
  let mayDispatch = false;

  await part("spend", async () => {
    const { month, start, end } = utcMonth(deps.now);
    const usage = await deps.store.monthUsage(start, end);
    const spend = monthToDateSpend(usage.events, usage.prices, deps.now);
    report.spend = { month: spend.month, spentUsd: spend.spentUsd, unpricedEvents: spend.unpricedEvents };
    if (!capReached(spend.spentUsd, SPEND_CAP_USD)) {
      mayDispatch = true;
      return;
    }
    report.capReached = true;
    // Idempotent: the flag is written only when it is not already set. Never cleared here.
    if (!(await deps.store.isAgentsPaused())) await deps.store.setAgentsPaused();
    log(`spend_cap_reached month=${month} spent=${spend.spentUsd.toFixed(2)}`);
  });

  await part("tasks", async () => {
    if (!mayDispatch) {
      log("sweeper: tasks skipped (no dispatch while the spend cap is reached or unknown)");
      return;
    }
    const tasks = await deps.store.listSweepTasks(MAX_SWEEP_TASKS);
    if (tasks.length === MAX_SWEEP_TASKS) log(`sweeper: ${MAX_SWEEP_TASKS} tasks, the limit; the rest wait for the next run`);
    for (const t of tasks) {
      const message: SweepMessage = { type: "sweep", task_id: t.id, thread_id: threadIdOf(t.id) };
      await deps.queue.send({ body: JSON.stringify(message), groupId: message.thread_id, dedupeId: sweepDedupeId(t.id, window) });
      report.swept += 1;
    }
  });

  await part("pause", async () => {
    report.paused = await deps.store.isAgentsPaused();
    if (!report.paused) return;
    const client = await gh();
    for (const run of await client.listActiveAgentRuns()) {
      if ((await client.cancelRun(run.id)) === "cancelled") report.cancelled += 1;
    }
  });

  await part("gc", async () => {
    const gcWindow = nightlyGcWindow(deps.scheduledTime);
    if (!gcWindow) {
      report.gc = "outside_window";
      return;
    }
    const client = await gh();
    if ((await client.countDispatchedRuns(PREVIEW_GC_WORKFLOW, gcWindow.start)) > 0) {
      report.gc = "already_dispatched";
      return;
    }
    // preview-gc.yml's dispatch defaults are a dry run; the nightly sweep cleans for real.
    await client.dispatchWorkflow({ workflow: PREVIEW_GC_WORKFLOW, ref: "main", inputs: { dry_run: "false", max_age_hours: "24" } });
    report.gc = "dispatched";
  });

  await part("redeliver", async () => {
    const client = await gh();
    const since = new Date(deps.now.getTime() - REDELIVERY_DEFAULTS.lookbackMinutes * 60_000);
    const deliveries = await client.listDeliveries(since, REDELIVERY_DEFAULTS.maxPages);
    const failedGuids = [...new Set(deliveries.filter((d) => d.status_code < 200 || d.status_code >= 400).map((d) => d.guid))];
    const recorded = await deps.store.knownDeliveries(failedGuids);
    const plan = selectRedeliveries(deliveries, recorded, { ...REDELIVERY_DEFAULTS, now: deps.now });
    report.redeliverySkipped = plan.skipped;
    for (const d of plan.redeliver) {
      await client.redeliver(d.id);
      report.redelivered += 1;
    }
  });

  log(
    `sweeper: window=${report.window} spend=${report.spend?.spentUsd.toFixed(2) ?? "unknown"} ` +
      `unpriced=${report.spend?.unpricedEvents ?? "unknown"} cap=${report.capReached ? "reached" : "ok"} ` +
      `swept=${report.swept} paused=${report.paused} cancelled=${report.cancelled} ` +
      `gc=${report.gc} redelivered=${report.redelivered}` +
      (Object.keys(report.failed).length > 0 ? ` failed=${Object.keys(report.failed).join(",")}` : ""),
  );
  return report;
}
