// Request shapes of the Octokit client against a mocked fetch (never the network): App auth
// (JWT -> installation token), each REST call, and the merge-rules artifact lookup and download.
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { MERGE_INPUT_ARTIFACT, MERGE_INPUT_FILE, MergeInputFormatError, serializeMergeInput, type MergeInput } from "@kcw/core/merge-input";
import { SecretKeyMissingError, createFakeSecrets } from "@kcw/secrets";
import { beforeEach, describe, expect, it } from "vitest";
import {
  APP_SECRET_KEYS,
  ArtifactFormatError,
  GitHubApiError,
  GitHubConfigError,
  MAX_ARTIFACT_BYTES,
  TOKEN_PERMISSIONS,
  createOctokitGitHubClient,
  githubClientFromSecret,
  readAppCredentials,
  type OctokitGitHubClient,
} from "../src/github";
import { writeZip } from "./zip-writer";

const { privateKey: pkcs8, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const pkcs1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const TOKEN = "ghs_synthetic_installation_token";
const CLIENT_ID = "Iv23synthetic";
const API = "https://api.github.com";
const BLOB = "https://blob.invalid/artifact.zip?sig=synthetic";

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => Response | undefined;

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

/** A fetch that answers the App token exchange itself and every other call from `routes`. */
class MockFetch {
  readonly calls: Call[] = [];
  routes: Route[] = [];
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = {
      method: (init.method ?? "GET").toUpperCase(),
      url: new URL(String(input)),
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    if (call.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(call.url.pathname)) {
      return json(201, { token: TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {}, repository_selection: "selected" });
    }
    for (const r of this.routes) {
      const res = r(call);
      if (res) return res;
    }
    return json(404, { message: "Not Found (mock)" });
  };

  /** Calls to the API other than the token exchange. */
  get api(): Call[] {
    return this.calls.filter((c) => !c.url.pathname.startsWith("/app/"));
  }

  on(method: string, path: string | RegExp, respond: (call: Call) => Response): this {
    this.routes.push((c) =>
      c.method === method && (typeof path === "string" ? c.url.pathname === path : path.test(c.url.pathname)) ? respond(c) : undefined,
    );
    return this;
  }
}

let mock: MockFetch;
let client: OctokitGitHubClient;

beforeEach(() => {
  mock = new MockFetch();
  client = createOctokitGitHubClient({ appId: CLIENT_ID, privateKey: pkcs8, installationId: 42 }, { repo: "o/r", fetch: mock.fetch });
});

function decodeJwt(jwt: string) {
  const [h, p, s] = jwt.split(".");
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(publicKey), Buffer.from(s!, "base64url"));
  return { ok, header: JSON.parse(Buffer.from(h!, "base64url").toString()), payload: JSON.parse(Buffer.from(p!, "base64url").toString()) };
}

describe("App authentication", () => {
  it("exchanges an RS256 JWT (iss = client id) for an installation token, then reuses the token", async () => {
    mock.on("POST", "/repos/o/r/issues", () => json(201, { number: 1, html_url: "https://github.com/o/r/issues/1" }));
    await client.createIssue({ title: "a", body: "b" });
    await client.createIssue({ title: "c", body: "d" });

    const exchanges = mock.calls.filter((c) => c.url.pathname.startsWith("/app/"));
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.url.pathname).toBe("/app/installations/42/access_tokens");
    const [scheme, jwt] = exchanges[0]!.headers.authorization!.split(" ");
    expect(scheme!.toLowerCase()).toBe("bearer");
    const decoded = decodeJwt(jwt!);
    expect(decoded.ok).toBe(true);
    expect(decoded.header.alg).toBe("RS256");
    expect(decoded.payload.iss).toBe(CLIENT_ID);
    // Q11: the token is scoped to this repository and the permissions the client's calls need.
    expect(exchanges[0]!.body).toEqual({
      repositories: ["r"],
      permissions: {
        actions: "write",
        checks: "write",
        contents: "write",
        issues: "write",
        metadata: "read",
        pull_requests: "read",
      },
    });
    expect((exchanges[0]!.body as { permissions: unknown }).permissions).toEqual(TOKEN_PERMISSIONS);

    for (const c of mock.api) expect(c.headers.authorization).toBe(`token ${TOKEN}`);
    expect(mock.api).toHaveLength(2);
  });

  it("accepts GitHub's PKCS#1 key format", async () => {
    const c = createOctokitGitHubClient({ appId: CLIENT_ID, privateKey: pkcs1.privateKey, installationId: 7 }, { repo: "o/r", fetch: mock.fetch });
    mock.on("POST", "/repos/o/r/actions/runs/1/cancel", () => json(202, {}));
    await expect(c.cancelRun(1)).resolves.toBe("cancelled");
    expect(mock.calls[0]!.url.pathname).toBe("/app/installations/7/access_tokens");
  });
});

describe("REST calls", () => {
  it("createIssue", async () => {
    mock.on("POST", "/repos/o/r/issues", () => json(201, { number: 12, html_url: "https://github.com/o/r/issues/12" }));
    await expect(client.createIssue({ title: "T", body: "B", labels: ["agent"] })).resolves.toEqual({
      number: 12,
      url: "https://github.com/o/r/issues/12",
    });
    expect(mock.api[0]!.body).toEqual({ title: "T", body: "B", labels: ["agent"] });
  });

  it("dispatchWorkflow defaults ref to main", async () => {
    mock.on("POST", "/repos/o/r/actions/workflows/agent-developer.yml/dispatches", () => json(204, null));
    await client.dispatchWorkflow({ workflow: "agent-developer.yml", inputs: { task_id: "7", mode: "implement" } });
    expect(mock.api[0]!.body).toEqual({ ref: "main", inputs: { task_id: "7", mode: "implement" } });
  });

  it("merge squashes at the evaluated head SHA", async () => {
    mock.on("PUT", "/repos/o/r/pulls/5/merge", () => json(200, { merged: true, sha: "m1", message: "ok" }));
    await expect(client.merge({ pr: 5, headSha: "h1" })).resolves.toEqual({ merged: true, sha: "m1" });
    expect(mock.api[0]!.body).toEqual({ sha: "h1", merge_method: "squash" });
  });

  it.each([
    [409, { merged: false, reason: "head_changed" }],
    [405, { merged: false, reason: "not_mergeable" }],
  ])("merge maps %i", async (status, expected) => {
    mock.on("PUT", "/repos/o/r/pulls/5/merge", () => json(status, { message: "x" }));
    await expect(client.merge({ pr: 5, headSha: "h1", title: "Squash" })).resolves.toEqual(expected);
    expect(mock.api[0]!.body).toEqual({ sha: "h1", merge_method: "squash", commit_title: "Squash" });
  });

  it("wraps other failures in GitHubApiError without the response body or token", async () => {
    mock.on("PUT", "/repos/o/r/pulls/5/merge", () => json(500, { message: "private detail" }));
    const err = await client.merge({ pr: 5, headSha: "h1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ operation: "merge", status: 500, message: "merge failed: GitHub returned 500" });
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("postCheck: pending is in_progress, success/failure complete the check", async () => {
    let id = 0;
    mock.on("POST", "/repos/o/r/check-runs", () => json(201, { id: ++id }));
    await expect(client.postCheck({ headSha: "h1", state: "pending", title: "Waiting", summary: "s" })).resolves.toEqual({ id: 1 });
    await client.postCheck({ headSha: "h1", state: "success", title: "OK", summary: "s", name: "kcw/other" });
    expect(mock.api.map((c) => c.body)).toEqual([
      { name: "kcw/merge-rules", head_sha: "h1", status: "in_progress", output: { title: "Waiting", summary: "s" } },
      { name: "kcw/other", head_sha: "h1", status: "completed", conclusion: "success", output: { title: "OK", summary: "s" } },
    ]);
  });

  it("cancelRun: 202 cancelled, 409 not running", async () => {
    mock.on("POST", "/repos/o/r/actions/runs/9/cancel", () => json(202, {}));
    mock.on("POST", "/repos/o/r/actions/runs/10/cancel", () => json(409, { message: "done" }));
    await expect(client.cancelRun(9)).resolves.toBe("cancelled");
    await expect(client.cancelRun(10)).resolves.toBe("not_running");
  });

  it("getDiff paginates the file list and flags an incomplete list", async () => {
    const file = (n: number) => ({ filename: `f${n}.ts`, status: "modified", patch: `@@ ${n}` });
    mock.on("GET", "/repos/o/r/pulls/3", () => json(200, { head: { sha: "h3", ref: "kcw/task-3" }, user: { login: "dev-app[bot]" }, changed_files: 3 }));
    mock.on("GET", "/repos/o/r/pulls/3/files", (c) =>
      c.url.searchParams.get("page") === "2"
        ? json(200, [{ filename: "new.ts", status: "renamed", previous_filename: "old.ts" }])
        : json(200, [file(1), file(2)], { link: `<${API}/repos/o/r/pulls/3/files?per_page=100&page=2>; rel="next"` }),
    );
    const diff = await client.getDiff(3);
    expect(diff).toEqual({
      headSha: "h3",
      author: "dev-app[bot]",
      files: [
        { path: "f1.ts", status: "modified" },
        { path: "f2.ts", status: "modified" },
        { path: "new.ts", status: "renamed", previousPath: "old.ts" },
      ],
      patches: { "f1.ts": "@@ 1", "f2.ts": "@@ 2", "new.ts": undefined },
      complete: true,
    });
    expect(mock.api[1]!.url.searchParams.get("per_page")).toBe("100");

    mock.routes.unshift((c) =>
      c.url.pathname === "/repos/o/r/pulls/3" ? json(200, { head: { sha: "h3" }, user: { login: "x" }, changed_files: 3001 }) : undefined,
    );
    expect((await client.getDiff(3)).complete).toBe(false);
  });
});

describe("getArtifact", () => {
  const input: MergeInput = {
    planSummary: { format: 1, infra: [], artifact: { count: 1, kinds: { create: 0, update: 1, delete: 0, replace: 0 } } },
    lockDiff: { added: [{ importer: "agents/orchestrator", name: "@octokit/rest" }], existing: ["pg"] },
  };
  const zip = writeZip([{ name: MERGE_INPUT_FILE, data: serializeMergeInput(input), descriptor: true }]);
  const run = (id: number, created: string, prs: { number: number; head: { sha: string } }[] = [{ number: 8, head: { sha: "h8" } }]) => ({
    id,
    created_at: created,
    head_sha: "h8",
    pull_requests: prs,
  });
  const artifact = (id: number, created: string, expired = false, size = zip.length) => ({
    id,
    name: MERGE_INPUT_ARTIFACT,
    created_at: created,
    expired,
    size_in_bytes: size,
  });

  function serveZip(body: Buffer = zip) {
    mock.on("GET", /^\/repos\/o\/r\/actions\/artifacts\/\d+\/zip$/, () => new Response(null, { status: 302, headers: { location: BLOB } }));
    mock.routes.push((c) =>
      c.url.href === BLOB ? new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "application/zip" } }) : undefined,
    );
  }

  it("lists ci.yml runs for the head SHA, takes the newest run's unexpired artifact and parses it", async () => {
    mock.on("GET", "/repos/o/r/actions/workflows/ci.yml/runs", () =>
      json(200, { total_count: 2, workflow_runs: [run(100, "2026-10-23T10:00:00Z"), run(101, "2026-10-23T11:00:00Z")] }),
    );
    mock.on("GET", "/repos/o/r/actions/runs/101/artifacts", () =>
      json(200, { total_count: 2, artifacts: [artifact(5, "2026-10-23T11:05:00Z", true), artifact(6, "2026-10-23T11:04:00Z")] }),
    );
    serveZip();

    await expect(client.getArtifact({ pr: 8, headSha: "h8" })).resolves.toEqual({ found: true, input, runId: 101, artifactId: 6 });

    const [runs, arts, dl, blob] = mock.api;
    expect(Object.fromEntries(runs!.url.searchParams)).toEqual({ event: "pull_request", head_sha: "h8", per_page: "30" });
    expect(arts!.url.searchParams.get("name")).toBe(MERGE_INPUT_ARTIFACT);
    expect(dl!.url.pathname).toBe("/repos/o/r/actions/artifacts/6/zip");
    // The signed storage URL is fetched without the installation token.
    expect(blob!.url.href).toBe(BLOB);
    expect(blob!.headers.authorization).toBeUndefined();
  });

  it("falls back to the PR branch's runs matched by pull_requests[].head.sha when the SHA query is empty", async () => {
    mock.on("GET", "/repos/o/r/actions/workflows/ci.yml/runs", (c) =>
      c.url.searchParams.has("head_sha")
        ? json(200, { total_count: 0, workflow_runs: [] })
        : json(200, {
            total_count: 3,
            workflow_runs: [
              { ...run(200, "2026-10-23T12:00:00Z"), head_sha: "merge-sha" },
              run(201, "2026-10-23T13:00:00Z", [{ number: 8, head: { sha: "older-head" } }]),
              run(202, "2026-10-23T09:00:00Z", [{ number: 9, head: { sha: "h8" } }]),
            ],
          }),
    );
    mock.on("GET", "/repos/o/r/pulls/8", () => json(200, { head: { sha: "h8", ref: "kcw/task-8" } }));
    mock.on("GET", "/repos/o/r/actions/runs/200/artifacts", () => json(200, { total_count: 1, artifacts: [artifact(7, "2026-10-23T12:05:00Z")] }));
    serveZip();

    await expect(client.getArtifact({ pr: 8, headSha: "h8" })).resolves.toMatchObject({ found: true, runId: 200, artifactId: 7 });
    const branchQuery = mock.api.filter((c) => c.url.pathname.endsWith("/runs"))[1]!;
    expect(Object.fromEntries(branchQuery.url.searchParams)).toEqual({ event: "pull_request", branch: "kcw/task-8", per_page: "30" });
  });

  it("ignores runs of another PR with the same head SHA", async () => {
    mock.on("GET", "/repos/o/r/actions/workflows/ci.yml/runs", (c) =>
      json(200, { workflow_runs: c.url.searchParams.has("head_sha") ? [run(300, "2026-10-23T10:00:00Z", [{ number: 99, head: { sha: "h8" } }])] : [] }),
    );
    mock.on("GET", "/repos/o/r/pulls/8", () => json(200, { head: { sha: "h8", ref: "kcw/task-8" } }));
    await expect(client.getArtifact({ pr: 8, headSha: "h8" })).resolves.toEqual({ found: false, reason: "no_run" });
  });

  it("no_artifact while the runs have none (or only expired ones)", async () => {
    mock.on("GET", "/repos/o/r/actions/workflows/ci.yml/runs", () => json(200, { workflow_runs: [run(1, "a"), run(2, "b")] }));
    mock.on("GET", "/repos/o/r/actions/runs/1/artifacts", () => json(200, { artifacts: [artifact(1, "a", true)] }));
    mock.on("GET", "/repos/o/r/actions/runs/2/artifacts", () => json(200, { artifacts: [] }));
    await expect(client.getArtifact({ pr: 8, headSha: "h8" })).resolves.toEqual({ found: false, reason: "no_artifact" });
  });

  describe("bad artifacts fail closed", () => {
    beforeEach(() => {
      mock.on("GET", "/repos/o/r/actions/workflows/ci.yml/runs", () => json(200, { workflow_runs: [run(1, "a")] }));
    });

    it("zip without the file", async () => {
      mock.on("GET", "/repos/o/r/actions/runs/1/artifacts", () => json(200, { artifacts: [artifact(1, "a")] }));
      serveZip(writeZip([{ name: "other.json", data: "{}" }]));
      await expect(client.getArtifact({ pr: 8, headSha: "h8" })).rejects.toThrow(ArtifactFormatError);
    });

    it("not a zip", async () => {
      mock.on("GET", "/repos/o/r/actions/runs/1/artifacts", () => json(200, { artifacts: [artifact(1, "a")] }));
      serveZip(Buffer.from("<html>error page</html>"));
      await expect(client.getArtifact({ pr: 8, headSha: "h8" })).rejects.toThrow(ArtifactFormatError);
    });

    it("file that parseMergeInput rejects", async () => {
      mock.on("GET", "/repos/o/r/actions/runs/1/artifacts", () => json(200, { artifacts: [artifact(1, "a")] }));
      serveZip(writeZip([{ name: MERGE_INPUT_FILE, data: '{"format":2}' }]));
      await expect(client.getArtifact({ pr: 8, headSha: "h8" })).rejects.toThrow(MergeInputFormatError);
    });

    it("declared size over the limit (not downloaded)", async () => {
      mock.on("GET", "/repos/o/r/actions/runs/1/artifacts", () => json(200, { artifacts: [artifact(1, "a", false, MAX_ARTIFACT_BYTES + 1)] }));
      await expect(client.getArtifact({ pr: 8, headSha: "h8" })).rejects.toThrow(ArtifactFormatError);
      expect(mock.api.some((c) => c.url.pathname.endsWith("/zip"))).toBe(false);
    });

    it("storage download failure is a GitHubApiError", async () => {
      mock.on("GET", "/repos/o/r/actions/runs/1/artifacts", () => json(200, { artifacts: [artifact(1, "a")] }));
      mock.on("GET", "/repos/o/r/actions/artifacts/1/zip", () => new Response(null, { status: 302, headers: { location: BLOB } }));
      mock.routes.push((c) => (c.url.href === BLOB ? new Response("gone", { status: 410 }) : undefined));
      await expect(client.getArtifact({ pr: 8, headSha: "h8" })).rejects.toMatchObject({ name: "GitHubApiError", status: 410 });
    });
  });
});

describe("credentials from kcw/prod/orchestrator", () => {
  const NAME = "kcw/prod/orchestrator";
  const values = { db_url: "postgres://u:p@db.invalid/x", github_app_client_id: CLIENT_ID, github_app_installation_id: "42", github_app_private_key: pkcs8 };

  it("reads the three App keys through @kcw/secrets", async () => {
    const { store, aws } = createFakeSecrets({ [NAME]: values });
    await expect(readAppCredentials(NAME, store)).resolves.toEqual({ appId: CLIENT_ID, privateKey: pkcs8, installationId: 42 });
    expect(new Set(aws.calls.map((c) => c.name))).toEqual(new Set([NAME]));
  });

  it("builds a working client (githubClientFromSecret)", async () => {
    const { store } = createFakeSecrets({ [NAME]: values });
    const c = await githubClientFromSecret(NAME, { secrets: store, repo: "o/r", fetch: mock.fetch });
    mock.on("POST", "/repos/o/r/actions/runs/1/cancel", () => json(202, {}));
    await expect(c.cancelRun(1)).resolves.toBe("cancelled");
    expect(mock.calls[0]!.url.pathname).toBe("/app/installations/42/access_tokens");
  });

  it("restores newlines of a key pasted as one line with literal \\n", async () => {
    const { store } = createFakeSecrets({ [NAME]: { ...values, github_app_private_key: pkcs8.replace(/\n/g, "\\n") } });
    expect((await readAppCredentials(NAME, store)).privateKey).toBe(pkcs8);
  });

  // P2-17 live bug: the key in the console lost its line breaks; the JWT could not be signed and the
  // first App call failed before any request (GitHubApiError without a status).
  const mangled = (pem: string) => ({
    "no line breaks (console single-line field)": pem.replace(/\n/g, ""),
    "spaces for line breaks": pem.trim().replace(/\n/g, " "),
    "CRLF line breaks": pem.replace(/\n/g, "\r\n"),
    "surrounding whitespace": `  ${pem}  \n`,
  });

  it.each(Object.entries(mangled(pkcs1.privateKey)).map(([l, k]) => [l, k] as const))(
    "a PKCS#1 key with %s is rebuilt and signs the App JWT",
    async (_l, key) => {
      const { store } = createFakeSecrets({ [NAME]: { ...values, github_app_private_key: key } });
      const creds = await readAppCredentials(NAME, store);
      expect(creds.privateKey).toBe(pkcs1.privateKey);
      const c = await githubClientFromSecret(NAME, { secrets: store, repo: "o/r", fetch: mock.fetch });
      mock.on("POST", "/repos/o/r/actions/runs/1/cancel", () => json(202, {}));
      await expect(c.cancelRun(1)).resolves.toBe("cancelled");
      const exchange = mock.calls.find((x) => x.url.pathname === "/app/installations/42/access_tokens")!;
      const [, jwt] = exchange.headers.authorization!.split(" ");
      const [h, p, s] = jwt!.split(".");
      expect(verify("sha256", Buffer.from(`${h}.${p}`), createPublicKey(pkcs1.publicKey), Buffer.from(s!, "base64url"))).toBe(true);
    },
  );

  it.each(Object.entries(mangled(pkcs8)).map(([l, k]) => [l, k] as const))("a PKCS#8 key with %s is rebuilt", async (_l, key) => {
    const { store } = createFakeSecrets({ [NAME]: { ...values, github_app_private_key: key } });
    expect((await readAppCredentials(NAME, store)).privateKey).toBe(pkcs8);
  });

  it("reproduces the live failure without normalization: no request is sent and the error has no status", async () => {
    const broken = createOctokitGitHubClient(
      { appId: CLIENT_ID, privateKey: pkcs1.privateKey.replace(/\n/g, ""), installationId: 42 },
      { repo: "o/r", fetch: mock.fetch },
    );
    const err = (await broken.cancelRun(1).catch((e: unknown) => e)) as GitHubApiError;
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err.status).toBeUndefined();
    expect(mock.calls).toEqual([]);
  });

  it("a PEM whose body does not parse is a config error naming the key, without key material", async () => {
    const fake = "-----BEGIN RSA PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=\n-----END RSA PRIVATE KEY-----\n";
    const { store } = createFakeSecrets({ [NAME]: { ...values, github_app_private_key: fake } });
    const err = (await readAppCredentials(NAME, store).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(GitHubConfigError);
    expect(err.message).toMatch(/^github_app_private_key does not parse as a private key/);
    expect(err.message).not.toContain("QUJD");
  });

  it.each([
    ["empty client id", { github_app_client_id: " " }, APP_SECRET_KEYS.appId],
    ["PEM with a non-base64 body", { github_app_private_key: "-----BEGIN PRIVATE KEY-----\nnot*base64\n-----END PRIVATE KEY-----" }, APP_SECRET_KEYS.privateKey],
    ["non-numeric installation id", { github_app_installation_id: "abc" }, APP_SECRET_KEYS.installationId],
    ["key that is not PEM", { github_app_private_key: "not-a-key-value" }, APP_SECRET_KEYS.privateKey],
  ])("rejects an %s, naming the key but not the value", async (_l, patch, key) => {
    const { store } = createFakeSecrets({ [NAME]: { ...values, ...patch } });
    const err = await readAppCredentials(NAME, store).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubConfigError);
    expect((err as Error).message).toContain(key);
    for (const v of Object.values(patch)) if (v.trim()) expect((err as Error).message).not.toContain(v);
  });

  it("a missing key surfaces as SecretKeyMissingError", async () => {
    const { github_app_installation_id: _omit, ...rest } = values;
    const { store } = createFakeSecrets({ [NAME]: rest });
    await expect(readAppCredentials(NAME, store)).rejects.toThrow(SecretKeyMissingError);
  });

  it("rejects a malformed repo", () => {
    expect(() => createOctokitGitHubClient({ appId: "1", privateKey: pkcs8, installationId: 1 }, { repo: "nope" })).toThrow(GitHubConfigError);
  });
});
