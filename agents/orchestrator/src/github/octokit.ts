// GitHubClient over the REST API, authenticated as the orchestrator GitHub App (DESIGN §4.1).
// @octokit/auth-app signs a JWT with the App's private key, exchanges it for an installation
// token (cached and renewed by auth-app, ~1 h) and sends that token on every request.
import { createPrivateKey } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { MERGE_INPUT_ARTIFACT, MERGE_INPUT_FILE, MergeInputFormatError, parseMergeInput } from "@kcw/core/merge-input";
import { getSecret } from "@kcw/secrets";
import {
  ArtifactFormatError,
  CI_WORKFLOW,
  DEFAULT_REPO,
  GitHubApiError,
  GitHubConfigError,
  MERGE_RULES_CHECK,
  type ArtifactResult,
  type CancelResult,
  type ChangedFile,
  type CreateIssueInput,
  type CreatedIssue,
  type DispatchWorkflowInput,
  type FindWorkflowRunInput,
  type GetArtifactInput,
  type GitHubClient,
  type MergePrInput,
  type MergeResult,
  type PostCheckInput,
  type PostedCheck,
  type PrDiff,
  type WorkflowRunInfo,
} from "./types";
import { ZipFormatError, readZipEntry } from "./zip";

/** Upper bound for the artifact zip and for the extracted JSON (the real file is a few KB). */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export interface AppCredentials {
  /** The App's client ID (`Iv...`, secret key github_app_client_id) or its numeric App ID; both work as the JWT issuer. */
  appId: string;
  /** PEM, PKCS#8 or PKCS#1 (GitHub's download format). */
  privateKey: string;
  installationId: number;
}

export interface OctokitClientOptions {
  /** `owner/name`; defaults to DEFAULT_REPO. */
  repo?: string;
  /** Injected in tests (never the network there). Also used for the artifact download. */
  fetch?: typeof fetch;
}

export function parseRepo(full: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/.exec(full);
  if (!m) throw new GitHubConfigError("repo must be owner/name");
  return { owner: m[1]!, repo: m[2]! };
}

function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
    ? err.status
    : undefined;
}

const newestFirst = (a: { created_at: string | null | undefined; id: number }, b: typeof a) =>
  (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.id - a.id;

export class OctokitGitHubClient implements GitHubClient {
  readonly owner: string;
  readonly repo: string;
  readonly #octokit: Octokit;
  readonly #fetch: typeof fetch;

  /** `octokit` must already be authenticated (see createOctokitGitHubClient). */
  constructor(octokit: Octokit, opts: OctokitClientOptions = {}) {
    ({ owner: this.owner, repo: this.repo } = parseRepo(opts.repo ?? DEFAULT_REPO));
    this.#octokit = octokit;
    this.#fetch = opts.fetch ?? fetch;
  }

  get #r() {
    return { owner: this.owner, repo: this.repo };
  }

  /** Runs one API call; any failure becomes a GitHubApiError carrying only the operation and status. */
  async #call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GitHubApiError || err instanceof ArtifactFormatError || err instanceof MergeInputFormatError) throw err;
      throw new GitHubApiError(operation, statusOf(err), { cause: err });
    }
  }

  async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    const { data } = await this.#call("createIssue", () =>
      this.#octokit.rest.issues.create({ ...this.#r, title: input.title, body: input.body, labels: input.labels ?? [] }),
    );
    return { number: data.number, url: data.html_url };
  }

  async dispatchWorkflow(input: DispatchWorkflowInput): Promise<void> {
    await this.#call("dispatchWorkflow", () =>
      this.#octokit.rest.actions.createWorkflowDispatch({
        ...this.#r,
        workflow_id: input.workflow,
        ref: input.ref ?? "main",
        inputs: input.inputs,
      }),
    );
  }

  async merge(input: MergePrInput): Promise<MergeResult> {
    try {
      const { data } = await this.#octokit.rest.pulls.merge({
        ...this.#r,
        pull_number: input.pr,
        sha: input.headSha,
        merge_method: "squash",
        ...(input.title !== undefined && { commit_title: input.title }),
      });
      return data.merged ? { merged: true, sha: data.sha } : { merged: false, reason: "not_mergeable" };
    } catch (err) {
      const status = statusOf(err);
      if (status === 409) return { merged: false, reason: "head_changed" };
      if (status === 405) return { merged: false, reason: "not_mergeable" };
      throw new GitHubApiError("merge", status, { cause: err });
    }
  }

  async postCheck(input: PostCheckInput): Promise<PostedCheck> {
    const { data } = await this.#call("postCheck", () =>
      this.#octokit.rest.checks.create({
        ...this.#r,
        name: input.name ?? MERGE_RULES_CHECK,
        head_sha: input.headSha,
        ...(input.state === "pending"
          ? { status: "in_progress" as const }
          : { status: "completed" as const, conclusion: input.state }),
        output: { title: input.title, summary: input.summary },
      }),
    );
    return { id: data.id };
  }

  async cancelRun(runId: number): Promise<CancelResult> {
    try {
      await this.#octokit.rest.actions.cancelWorkflowRun({ ...this.#r, run_id: runId });
      return "cancelled";
    } catch (err) {
      // 409: the run already completed.
      if (statusOf(err) === 409) return "not_running";
      throw new GitHubApiError("cancelRun", statusOf(err), { cause: err });
    }
  }

  async getDiff(pr: number): Promise<PrDiff> {
    return this.#call("getDiff", async () => {
      const { data: pull } = await this.#octokit.rest.pulls.get({ ...this.#r, pull_number: pr });
      const listed = await this.#octokit.paginate(this.#octokit.rest.pulls.listFiles, {
        ...this.#r,
        pull_number: pr,
        per_page: 100,
      });
      const files: ChangedFile[] = [];
      const patches: Record<string, string | undefined> = {};
      for (const f of listed) {
        files.push({
          path: f.filename,
          status: f.status,
          ...(f.previous_filename !== undefined && { previousPath: f.previous_filename }),
        });
        patches[f.filename] = f.patch;
      }
      return {
        headSha: pull.head.sha,
        author: pull.user.login,
        files,
        patches,
        complete: files.length >= pull.changed_files,
      };
    });
  }

  async getArtifact(input: GetArtifactInput): Promise<ArtifactResult> {
    return this.#call("getArtifact", async () => {
      const runs = await this.#ciRuns(input);
      if (runs.length === 0) return { found: false, reason: "no_run" } as const;
      for (const run of runs) {
        const { data } = await this.#octokit.rest.actions.listWorkflowRunArtifacts({
          ...this.#r,
          run_id: run.id,
          name: MERGE_INPUT_ARTIFACT,
          per_page: 100,
        });
        const artifact = data.artifacts
          .filter((a) => a.name === MERGE_INPUT_ARTIFACT && !a.expired)
          .sort(newestFirst)[0];
        if (!artifact) continue;
        const zip = await this.#download(artifact.id, artifact.size_in_bytes);
        let file: Buffer | undefined;
        try {
          file = readZipEntry(zip, MERGE_INPUT_FILE, { maxBytes: MAX_ARTIFACT_BYTES });
        } catch (err) {
          if (err instanceof ZipFormatError) throw new ArtifactFormatError(err.message, { cause: err });
          throw err;
        }
        if (!file) throw new ArtifactFormatError(`${MERGE_INPUT_ARTIFACT} has no ${MERGE_INPUT_FILE}`);
        // parseMergeInput throws MergeInputFormatError on any deviation: callers fail closed.
        return { found: true, input: parseMergeInput(file.toString("utf8")), runId: run.id, artifactId: artifact.id };
      }
      return { found: false, reason: "no_artifact" } as const;
    });
  }

  async findWorkflowRun(input: FindWorkflowRunInput): Promise<WorkflowRunInfo | null> {
    return this.#call("findWorkflowRun", async () => {
      const { data } = await this.#octokit.rest.actions.listWorkflowRuns({
        ...this.#r,
        workflow_id: input.workflow,
        event: "workflow_dispatch",
        created: `>=${input.createdAfter}`,
        per_page: 30,
      });
      const after = Date.parse(input.createdAfter);
      const run = data.workflow_runs
        .filter((r) => r.display_title === input.displayTitle && Date.parse(r.created_at) >= after)
        .sort(newestFirst)[0];
      return run ? { id: run.id, status: run.status ?? "unknown", conclusion: run.conclusion ?? null } : null;
    });
  }

  /**
   * ci.yml runs of the PR's head, newest first. A pull_request run's `head_sha` is expected to be
   * the PR head (not the test merge commit GITHUB_SHA), so the first query filters by it. If it
   * finds nothing, the fallback lists the PR branch's pull_request runs and keeps those whose
   * `pull_requests` entry for this PR has the head SHA, which works whichever SHA the run carries.
   */
  async #ciRuns({ pr, headSha }: GetArtifactInput) {
    const forThisPr = (r: { pull_requests: { number: number }[] | null }) =>
      !r.pull_requests || r.pull_requests.length === 0 || r.pull_requests.some((p) => p.number === pr);
    const { data: bySha } = await this.#octokit.rest.actions.listWorkflowRuns({
      ...this.#r,
      workflow_id: CI_WORKFLOW,
      event: "pull_request",
      head_sha: headSha,
      per_page: 30,
    });
    const direct = bySha.workflow_runs.filter(forThisPr);
    if (direct.length > 0) return direct.sort(newestFirst);

    const { data: pull } = await this.#octokit.rest.pulls.get({ ...this.#r, pull_number: pr });
    const { data: byBranch } = await this.#octokit.rest.actions.listWorkflowRuns({
      ...this.#r,
      workflow_id: CI_WORKFLOW,
      event: "pull_request",
      branch: pull.head.ref,
      per_page: 30,
    });
    return byBranch.workflow_runs
      .filter((r) => r.pull_requests?.some((p) => p.number === pr && p.head.sha === headSha))
      .sort(newestFirst);
  }

  /**
   * The download endpoint answers 302 with a short-lived signed URL (GitHub docs). The redirect is
   * followed here with a plain fetch, so the installation token is never sent to the storage host.
   */
  async #download(artifactId: number, declaredSize: number): Promise<Buffer> {
    if (declaredSize > MAX_ARTIFACT_BYTES) throw new ArtifactFormatError(`artifact larger than ${MAX_ARTIFACT_BYTES} bytes`);
    const res = await this.#octokit.request("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}", {
      ...this.#r,
      artifact_id: artifactId,
      archive_format: "zip",
      request: { redirect: "manual" },
    });
    const status = res.status as number;
    const location = res.headers.location;
    if (status < 300 || status >= 400 || typeof location !== "string") {
      throw new GitHubApiError("getArtifact download", status);
    }
    const blob = await this.#fetch(location, { redirect: "follow" });
    if (!blob.ok) throw new GitHubApiError("getArtifact download", blob.status);
    const length = Number(blob.headers.get("content-length") ?? "0");
    if (length > MAX_ARTIFACT_BYTES) throw new ArtifactFormatError(`artifact larger than ${MAX_ARTIFACT_BYTES} bytes`);
    const body = Buffer.from(await blob.arrayBuffer());
    if (body.length > MAX_ARTIFACT_BYTES) throw new ArtifactFormatError(`artifact larger than ${MAX_ARTIFACT_BYTES} bytes`);
    return body;
  }
}

/**
 * What the installation token may do (DESIGN §11 Q11): the least the calls above need, a subset of
 * the App's permissions (§4.1). Per GitHub's "Permissions required for GitHub Apps":
 * - actions write: workflow dispatch and run cancel; read covers listing runs, their artifacts and
 *   the artifact download;
 * - checks write: create the `kcw/merge-rules` check run;
 * - contents write: merge a pull request (listed under Contents only);
 * - issues write: create issues;
 * - pull_requests read: get a pull request and list its files;
 * - metadata read: implied for every token.
 * Not requested: pull_requests write and statuses read (the App has them; no call needs them).
 */
export const TOKEN_PERMISSIONS = {
  actions: "write",
  checks: "write",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "read",
} as const satisfies Record<string, "read" | "write">;

/** Octokit's request function as an auth hook sees it (typed loosely: @octokit/types is not a direct dependency). */
interface HookRequest {
  (options: unknown): Promise<unknown>;
  endpoint: {
    merge(route: unknown, parameters?: unknown): { url: string; headers: Record<string, string | undefined> };
    DEFAULTS: { baseUrl: string };
  };
}

/** createAppAuth's result, as used here. */
interface AppAuth {
  (opts: { type: "installation"; repositoryNames: string[]; permissions: Record<string, string> }): Promise<{ token: string }>;
  hook(request: HookRequest, route: unknown, parameters?: unknown): Promise<unknown>;
}

/**
 * An Octokit auth strategy that sends every REST call with an installation token scoped to one
 * repository and TOKEN_PERMISSIONS. createAppAuth's own hook always asks for an unscoped token
 * (it passes no repository or permission options), so this hook asks createAppAuth for the
 * scoped one explicitly. createAppAuth still signs the JWT, caches the token per scope, and
 * handles the App endpoints (`/app/...`, including the token exchange itself, which needs the JWT).
 */
function scopedInstallationAuth(options: {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryName: string;
  request?: unknown;
  log?: unknown;
}) {
  const { repositoryName, ...appOptions } = options;
  const appAuth = createAppAuth(appOptions as Parameters<typeof createAppAuth>[0]) as unknown as AppAuth;
  const scope = { type: "installation" as const, repositoryNames: [repositoryName], permissions: { ...TOKEN_PERMISSIONS } };
  const auth = () => appAuth(scope);
  const hook = async (request: HookRequest, route: unknown, parameters?: unknown) => {
    const endpoint = request.endpoint.merge(route, parameters);
    const path = endpoint.url.replace(request.endpoint.DEFAULTS.baseUrl, "");
    if (/^\/app(?:[/?]|$)/.test(path)) return appAuth.hook(request, route, parameters);
    endpoint.headers.authorization = `token ${(await appAuth(scope)).token}`;
    return request(endpoint);
  };
  return Object.assign(auth, { hook });
}

/** An Octokit authenticated as one installation of a GitHub App, with a token scoped to `repo` (owner/name). */
export function createAppOctokit(
  creds: AppCredentials,
  opts: Pick<OctokitClientOptions, "fetch"> & { repo?: string } = {},
): Octokit {
  return new Octokit({
    authStrategy: scopedInstallationAuth,
    auth: {
      appId: creds.appId,
      privateKey: creds.privateKey,
      installationId: creds.installationId,
      repositoryName: parseRepo(opts.repo ?? DEFAULT_REPO).repo,
    },
    userAgent: "kcw-orchestrator",
    ...(opts.fetch && { request: { fetch: opts.fetch } }),
  });
}

export function createOctokitGitHubClient(creds: AppCredentials, opts: OctokitClientOptions = {}): OctokitGitHubClient {
  return new OctokitGitHubClient(createAppOctokit(creds, opts), opts);
}

/** Keys of the orchestrator's secret `kcw/prod/orchestrator` (DESIGN §6). */
export const APP_SECRET_KEYS = {
  appId: "github_app_client_id",
  installationId: "github_app_installation_id",
  privateKey: "github_app_private_key",
} as const;

export interface SecretGetter {
  get(name: string, key: string): Promise<string>;
}

/**
 * Reads the App credentials from the orchestrator's secret (D9: env holds the secret *name*).
 * Errors name the secret key, never a value.
 */
export async function readAppCredentials(secretName: string, secrets?: SecretGetter): Promise<AppCredentials> {
  const get = (key: string) => (secrets ? secrets.get(secretName, key) : getSecret(secretName, key));
  const [appId, installation, key] = await Promise.all([
    get(APP_SECRET_KEYS.appId),
    get(APP_SECRET_KEYS.installationId),
    get(APP_SECRET_KEYS.privateKey),
  ]);
  if (appId.trim() === "") throw new GitHubConfigError(`${APP_SECRET_KEYS.appId} is empty`);
  if (!/^\d+$/.test(installation.trim()) || Number(installation) < 1) {
    throw new GitHubConfigError(`${APP_SECRET_KEYS.installationId} must be a positive integer`);
  }
  return { appId: appId.trim(), privateKey: normalizePrivateKey(key), installationId: Number(installation.trim()) };
}

const PEM = /-----BEGIN ((?:RSA )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;

/**
 * Rebuilds the App's PEM key so it parses whatever happened to its line breaks, then checks that
 * it does. A key pasted into the Secrets Manager console's key/value field loses its newlines
 * (single-line input) or gets spaces or literal `\n` instead; the JWT library then fails before
 * any request (Node: "DECODER routines::unsupported" for PKCS#1, WebCrypto "Invalid keyData" for
 * PKCS#8), which surfaced as a status-less GitHubApiError on the first App call (P2-17 sweeper).
 * Errors name the setting and the parser's error, never key material.
 */
export function normalizePrivateKey(raw: string): string {
  const m = PEM.exec(raw.replace(/\\n/g, "\n"));
  if (!m) throw new GitHubConfigError(`${APP_SECRET_KEYS.privateKey} is not a PEM private key`);
  const body = m[2]!.replace(/\s+/g, "");
  if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new GitHubConfigError(`${APP_SECRET_KEYS.privateKey} has a malformed PEM body`);
  }
  const pem = `-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END ${m[1]}-----\n`;
  try {
    createPrivateKey(pem);
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err ? ` ${String(err.code)}` : "";
    throw new GitHubConfigError(`${APP_SECRET_KEYS.privateKey} does not parse as a private key${code}`, { cause: err });
  }
  return pem;
}

/** The production client: credentials from the orchestrator secret, Octokit with App auth. */
export async function githubClientFromSecret(
  secretName: string,
  opts: OctokitClientOptions & { secrets?: SecretGetter } = {},
): Promise<OctokitGitHubClient> {
  return createOctokitGitHubClient(await readAppCredentials(secretName, opts.secrets), opts);
}
