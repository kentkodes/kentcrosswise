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

/** The prod deploy workflow (AR8a): its runs are what the `releases` sweeper part reads. */
export const DEPLOY_WORKFLOW = "deploy.yml";
/** The deploy step whose success means the new build is live at the edge (the cache clear, O6). */
export const DEPLOY_CLEAR_CACHE_STEP = "Clear the CloudFront cache";
/** The deploy job (the workflow's only job). */
export const DEPLOY_JOB = "deploy";
/** Title of the `::notice` annotation that the deploy step `Record build id` prints. */
export const BUILD_ID_ANNOTATION_TITLE = "kcw-build-id";
/** A build id the sweeper accepts from an annotation (same pattern as task_releases.build_id). */
export const BUILD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A deploy workflow run, as listed. */
export interface DeployRun {
  id: number;
  runAttempt: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  createdAt: Date;
}

/** The latest attempt's deploy job of a run. */
export interface DeployJob {
  conclusion: string | null;
  completedAt: Date | null;
  /** The `Clear the CloudFront cache` step; null when the job has no such step. */
  clearCache: { conclusion: string | null; completedAt: Date | null } | null;
  /** From the `kcw-build-id` annotation, only when it matches BUILD_ID_PATTERN; else null. */
  buildId: string | null;
}

/** The build id of the first annotation titled BUILD_ID_ANNOTATION_TITLE whose message is a valid id. */
export function buildIdFromAnnotations(annotations: readonly { title?: string | null; message?: string | null }[]): string | null {
  for (const a of annotations) {
    if (a.title === BUILD_ID_ANNOTATION_TITLE && typeof a.message === "string" && BUILD_ID_PATTERN.test(a.message)) return a.message;
  }
  return null;
}

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
  /** Deploy workflow runs on main created at or after `since`, newest first, one call (per_page 50). */
  listDeployRuns(since: Date): Promise<DeployRun[]>;
  /** The deploy job of the run's latest attempt, or null when the run has none. */
  getDeployJob(runId: number): Promise<DeployJob | null>;
  /** True when `head` is `base` or a descendant of it (compare status identical or ahead). */
  isDescendant(base: string, head: string): Promise<boolean>;
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

  listDeployRuns(since: Date): Promise<DeployRun[]> {
    return this.#call("listDeployRuns", async () => {
      const { data } = await this.#octokit.rest.actions.listWorkflowRuns({
        ...this.#r,
        workflow_id: DEPLOY_WORKFLOW,
        branch: "main",
        created: `>=${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
        per_page: 50,
      });
      return data.workflow_runs.map((r) => ({
        id: r.id,
        runAttempt: r.run_attempt ?? 1,
        headSha: r.head_sha,
        status: r.status ?? "unknown",
        conclusion: r.conclusion ?? null,
        createdAt: new Date(r.created_at),
      }));
    });
  }

  getDeployJob(runId: number): Promise<DeployJob | null> {
    return this.#call("getDeployJob", async () => {
      const { data } = await this.#octokit.rest.actions.listJobsForWorkflowRun({ ...this.#r, run_id: runId, filter: "latest", per_page: 100 });
      const job = data.jobs.find((j) => j.name === DEPLOY_JOB);
      if (!job) return null;
      const step = job.steps?.find((s) => s.name === DEPLOY_CLEAR_CACHE_STEP);
      const { data: annotations } = await this.#octokit.rest.checks.listAnnotations({ ...this.#r, check_run_id: job.id, per_page: 50 });
      return {
        conclusion: job.conclusion ?? null,
        completedAt: job.completed_at ? new Date(job.completed_at) : null,
        clearCache: step ? { conclusion: step.conclusion ?? null, completedAt: step.completed_at ? new Date(step.completed_at) : null } : null,
        buildId: buildIdFromAnnotations(annotations),
      };
    });
  }

  isDescendant(base: string, head: string): Promise<boolean> {
    return this.#call("isDescendant", async () => {
      const { data } = await this.#octokit.rest.repos.compareCommitsWithBasehead({ ...this.#r, basehead: `${base}...${head}`, per_page: 1 });
      return data.status === "ahead" || data.status === "identical";
    });
  }
}
