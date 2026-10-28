// The relay's request logic (DESIGN §1, §4.3), independent of Lambda: verify the signature, drop
// senders that are not our Apps or the owner, normalize, resolve the task, dedupe by delivery id,
// enqueue. Responses never echo the request.
import { threadIdOf } from "@kcw/core/events";
import { normalize, senderOf } from "./normalize";
import type { GitHubEventMessage, OrchestratorQueue } from "./queue";
import { verifySignature } from "./signature";
import { GITHUB_SOURCE, type RelayStore } from "./store";
import { taskIdFromBranch } from "./task";
import { actionsMinutesOf } from "./usage";

export interface RelayRequest {
  method: string;
  /** Header names in any case. */
  headers: Readonly<Record<string, string | undefined>>;
  /** The exact body bytes GitHub sent. */
  body: Uint8Array;
}

export type RelayResult = "forwarded" | "duplicate" | "ignored" | "pong" | "rejected" | "error";

export interface RelayResponse {
  status: number;
  body: { result: RelayResult; reason?: string };
}

export interface RelayDeps {
  /** The webhook secret (`kcw/github/webhook-secret`, key `secret`). */
  secret: string;
  /** GitHub account ids (`sender.id`) of our Apps' bot users and the owner. */
  allowedSenderIds: ReadonlySet<number>;
  store: RelayStore;
  queue: OrchestratorQueue;
  /** One line per delivery: result, event, delivery id, reason. Never payload content. */
  log?: (line: string) => void;
  /** Waits between dispatch link lookups; injected in tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Lookups of an agent run's dispatch link when the run has no task title yet (RUN-ID-MAPPING-SPEC
 * §3 step 4): the orchestrator stores the link right after GitHub answers the dispatch, which can
 * be after GitHub sent `requested`. Two waits of ~1 s keep the answer well inside GitHub's 10 s
 * delivery timeout and the relay Lambda's timeout (10 s).
 */
export const DISPATCH_LOOKUPS = 3;
export const DISPATCH_LOOKUP_DELAY_MS = 1000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** GitHub delivery ids are GUIDs; also within SQS's MessageDeduplicationId limits (128 chars). */
const DELIVERY_ID = /^[A-Za-z0-9-]{1,128}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

function respond(status: number, result: RelayResult, reason?: string): RelayResponse {
  return { status, body: reason === undefined ? { result } : { result, reason } };
}

export async function handleDelivery(req: RelayRequest, deps: RelayDeps): Promise<RelayResponse> {
  const headers = new Map(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const rawEvent = headers.get("x-github-event") ?? "";
  const rawDelivery = headers.get("x-github-delivery") ?? "";
  // Only validated values are logged.
  const event = EVENT_NAME.test(rawEvent) ? rawEvent : "?";
  const delivery = DELIVERY_ID.test(rawDelivery) ? rawDelivery : "?";
  const done = (r: RelayResponse, detail?: string): RelayResponse => {
    deps.log?.(
      `relay: ${r.body.result}${r.body.reason ? ` (${r.body.reason})` : ""} event=${event} delivery=${delivery}` +
        (detail ? ` ${detail}` : ""),
    );
    return r;
  };

  if (req.method.toUpperCase() !== "POST") return done(respond(405, "rejected", "method"));

  const signature = verifySignature(req.body, headers.get("x-hub-signature-256"), deps.secret);
  if (signature !== "valid") return done(respond(401, "rejected", `signature_${signature}`));

  if (event === "?") return done(respond(400, "rejected", "event_header"));
  if (delivery === "?") return done(respond(400, "rejected", "delivery_header"));

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(req.body).toString("utf8"));
  } catch {
    return done(respond(400, "rejected", "json"));
  }

  if (event === "ping") return done(respond(200, "pong"));

  const sender = senderOf(payload);
  if (!sender || !deps.allowedSenderIds.has(sender.id)) return done(respond(202, "ignored", "sender"));

  const n = normalize(event, payload);
  if (!n.ok) return done(respond(202, "ignored", n.reason));
  const { hint } = n.value;

  // An agent run that passed normalize's guards maps by run id first (RUN-ID-MAPPING-SPEC §3):
  // its dispatch link, cross-checked with the path role and any title task id; else the title;
  // else the link is not stored yet (`pending`). Never by path alone, never by PR/issue/branch.
  let taskId: number | null = null;
  let agentRun: "dispatch" | "title" | "mismatch" | "pending" | undefined;
  try {
    if (hint.agent_run) {
      const sleep = deps.sleep ?? defaultSleep;
      for (let lookup = 1; ; lookup++) {
        const link = await deps.store.findDispatch(hint.agent_run.run_id);
        if (link) {
          const agrees = link.role === hint.agent_run.role &&
            (hint.agent_task_id === undefined || hint.agent_task_id === link.task_id);
          agentRun = agrees ? "dispatch" : "mismatch";
          if (agrees) taskId = link.task_id;
          break;
        }
        if (hint.agent_task_id !== undefined) {
          agentRun = "title";
          taskId = hint.agent_task_id;
          break;
        }
        if (lookup >= DISPATCH_LOOKUPS) {
          agentRun = "pending";
          break;
        }
        await sleep(DISPATCH_LOOKUP_DELAY_MS);
      }
    } else {
      taskId = taskIdFromBranch(hint.branch);
      if (taskId === null && hint.pr_number !== undefined) taskId = await deps.store.findTaskByPr(hint.pr_number);
      if (taskId === null && hint.issue_number !== undefined) taskId = await deps.store.findTaskByIssue(hint.issue_number);
    }
  } catch (err) {
    return done(respond(500, "error", "db"), errName(err));
  }

  // Actions minutes of every completed run from an allowed sender, task or not (deploys, owner
  // PRs). Recorded before the delivery claim, so a redelivery after a failure still records them;
  // the row's dedupe key (run id + attempt) keeps redeliveries from counting twice.
  let minutesNote: string | undefined;
  if (n.value.payload.type === "workflow_run") {
    const usage = actionsMinutesOf(n.value.payload);
    if (usage) {
      try {
        const recorded = await deps.store.recordActionsMinutes(usage, taskId);
        minutesNote = recorded ? `minutes=${usage.minutes}` : "minutes=duplicate";
      } catch (err) {
        return done(respond(500, "error", "db"), errName(err));
      }
    }
  }
  if (agentRun === "mismatch") return done(respond(202, "ignored", "dispatch_mismatch"), minutesNote);
  // Not claimed: GitHub's redelivery (sweeper, 5xx deliveries) is processed once the link exists.
  // Runs the orchestrator never linked (scraper, manual dispatches, a null dispatch run id) stay on
  // this path until the redeliveries run out; the fixed role/action fields make them greppable.
  if (agentRun === "pending" && hint.agent_run && n.value.payload.type === "workflow_run") {
    const fields = `role=${hint.agent_run.role} action=${n.value.payload.action}`;
    return done(respond(503, "error", "dispatch_pending"), minutesNote ? `${fields} ${minutesNote}` : fields);
  }
  if (agentRun === "pending") return done(respond(503, "error", "dispatch_pending"), minutesNote); // unreachable: agent_run is set
  if (taskId === null) return done(respond(202, "ignored", "no_task"), minutesNote);

  // The orchestrator records an agent run only with the relay-derived task id on the payload
  // (agentRunRole), whether it came from the dispatch link or the title.
  const forwarded =
    agentRun !== undefined && n.value.payload.type === "workflow_run" ? { ...n.value.payload, agent_task_id: taskId } : n.value.payload;
  const message: GitHubEventMessage = {
    source: "github",
    delivery_id: delivery,
    task_id: taskId,
    thread_id: threadIdOf(taskId),
    resume: { event: n.value.event, head_sha: n.value.head_sha, payload: forwarded },
  };

  let claimed: boolean;
  try {
    claimed = await deps.store.claimDelivery(delivery, GITHUB_SOURCE);
  } catch (err) {
    return done(respond(500, "error", "db"), errName(err));
  }
  if (!claimed) return done(respond(200, "duplicate"), minutesNote);

  try {
    await deps.queue.send(message);
  } catch (err) {
    // Undo the claim so a redelivery of this id is processed, then report the failure to GitHub.
    let released = "released";
    try {
      await deps.store.releaseDelivery(delivery);
    } catch {
      released = "release_failed";
    }
    return done(respond(502, "error", "queue"), `${errName(err)} ${released}`);
  }
  return done(
    respond(200, "forwarded"),
    `${message.thread_id} ${message.resume.event}${minutesNote ? ` ${minutesNote}` : ""}${agentRun ? ` map=${agentRun}` : ""}`,
  );
}

/** Only the error class/AWS error name: messages may contain connection strings. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}
