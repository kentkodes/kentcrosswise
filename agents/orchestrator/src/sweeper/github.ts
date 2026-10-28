// The sweeper's GitHub calls, as the orchestrator App (same credentials and token scope as the
// task graph's client, DESIGN §11 Q11). Per GitHub's REST docs:
// - list workflow runs for a repository (actions: read, covered by actions: write);
// - cancel a workflow run and create a workflow dispatch event (actions: write);
// - list deliveries / redeliver a delivery for an app webhook (GET /app/hook/deliveries,
//   POST /app/hook/deliveries/{delivery_id}/attempts): "You must use a JWT", no installation
//   permission. createAppOctokit sends /app/... paths with the App JWT.
import type { Octokit } from "@octokit/rest";
import { GitHubApiError, type CancelResult, type DispatchResult, type DispatchWorkflowInput } from "../github/types";
import { OctokitGitHubClient, parseRepo } from "../github/octokit";
import type { WebhookDelivery } from "./deliveries";

/** The nightly preview GC workflow (DESIGN §5 step 6). */
export const PREVIEW_GC_WORKFLOW = "preview-gc.yml";

/** Agent workflows (§4.1): `.github/workflows/agent-<name>.yml`. */
const AGENT_WORKFLOW_FILE = /^agent-[A-Za-z0-9_.-]+\.ya?ml$/;

/**
 * True for a run of an agent workflow. A run's `path` is the workflow file
 * (`.github/workflows/agent-developer.yml`); a `@<ref>` suffix, if GitHub adds one, is ignored.
 */
export function isAgentWorkflowPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const file = path.split("@")[0]!;
  return file.startsWith(".github/workflows/") && AGENT_WORKFLOW_FILE.test(file.slice(".github/workflows/".length));
}

/** Run statuses that can still be cancelled and are listed (one request each). */
export const ACTIVE_RUN_STATUSES = ["in_progress", "queued", "waiting", "pending", "requested"] as const;

export interface ActiveRun {
  id: number;
  path: string;
  status: string;
}

export interface SweeperGitHub {
  /** Runs of agent workflows that have not completed. */
  listActiveAgentRuns(): Promise<ActiveRun[]>;
  cancelRun(runId: number): Promise<CancelResult>;
  /**
   * Only preview-gc.yml (PREVIEW_GC_WORKFLOW), never an agent workflow, so no agent_dispatches link
   * is recorded for it (RUN-ID-MAPPING-SPEC §2); agent re-dispatches go through the task graph.
   */
  dispatchWorkflow(input: DispatchWorkflowInput): Promise<DispatchResult>;
  /** workflow_dispatch runs of `workflow` created at or after `since`. */
  countDispatchedRuns(workflow: string, since: Date): Promise<number>;
  /** App webhook delivery attempts delivered at or after `since`, newest first, at most `maxPages` pages of 100. */
  listDeliveries(since: Date, maxPages: number): Promise<WebhookDelivery[]>;
  redeliver(deliveryId: number): Promise<void>;
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number" ? err.status : undefined;
}

export class OctokitSweeperGitHub implements SweeperGitHub {
  readonly #octokit: Octokit;
  readonly #client: OctokitGitHubClient;
  readonly #r: { owner: string; repo: string };

  /** `octokit` from createAppOctokit (App auth); `repo` is owner/name. */
  constructor(octokit: Octokit, repo: string) {
    this.#octokit = octokit;
    this.#client = new OctokitGitHubClient(octokit, { repo });
    this.#r = parseRepo(repo);
  }

  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GitHubApiError) throw err;
      throw new GitHubApiError(operation, statusOf(err), { cause: err });
    }
  }

  listActiveAgentRuns(): Promise<ActiveRun[]> {
    return this.#call("listActiveAgentRuns", async () => {
      const seen = new Map<number, ActiveRun>();
      for (const status of ACTIVE_RUN_STATUSES) {
        const { data } = await this.#octokit.rest.actions.listWorkflowRunsForRepo({ ...this.#r, status, per_page: 100 });
        for (const run of data.workflow_runs) {
          if (isAgentWorkflowPath(run.path)) seen.set(run.id, { id: run.id, path: run.path, status: run.status ?? status });
        }
      }
      return [...seen.values()];
    });
  }

  cancelRun(runId: number): Promise<CancelResult> {
    return this.#client.cancelRun(runId);
  }

  dispatchWorkflow(input: DispatchWorkflowInput): Promise<DispatchResult> {
    return this.#client.dispatchWorkflow(input);
  }

  countDispatchedRuns(workflow: string, since: Date): Promise<number> {
    return this.#call("countDispatchedRuns", async () => {
      const { data } = await this.#octokit.rest.actions.listWorkflowRuns({
        ...this.#r,
        workflow_id: workflow,
        event: "workflow_dispatch",
        created: `>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
        per_page: 1,
      });
      return data.total_count;
    });
  }

  listDeliveries(since: Date, maxPages: number): Promise<WebhookDelivery[]> {
    return this.#call("listDeliveries", async () => {
      const out: WebhookDelivery[] = [];
      let pages = 0;
      for await (const { data } of this.#octokit.paginate.iterator(this.#octokit.rest.apps.listWebhookDeliveries, { per_page: 100 })) {
        pages += 1;
        let older = false;
        for (const d of data) {
          if (Date.parse(d.delivered_at) < since.getTime()) {
            older = true;
            continue;
          }
          out.push({
            id: d.id,
            guid: d.guid,
            delivered_at: d.delivered_at,
            redelivery: d.redelivery,
            status_code: d.status_code,
            event: d.event,
          });
        }
        if (older || data.length === 0 || pages >= maxPages) break;
      }
      return out;
    });
  }

  redeliver(deliveryId: number): Promise<void> {
    return this.#call("redeliver", async () => {
      await this.#octokit.rest.apps.redeliverWebhookDelivery({ delivery_id: deliveryId });
    });
  }
}
