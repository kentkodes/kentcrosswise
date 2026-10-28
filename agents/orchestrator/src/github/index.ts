// @kcw/orchestrator/github (P2-09): the orchestrator's GitHub client.
export * from "./types";
export { FAKE_FIRST_RUN_ID, FakeGitHubClient, type FakeCheck, type FakeGitHubOptions, type FakeMethod, type FakePr } from "./fake";
export {
  APP_SECRET_KEYS,
  DISPATCH_API_VERSION,
  DISPATCH_RUN_ID_MISSING,
  MAX_ARTIFACT_BYTES,
  OctokitGitHubClient,
  TOKEN_PERMISSIONS,
  createAppOctokit,
  createOctokitGitHubClient,
  githubClientFromSecret,
  normalizePrivateKey,
  parseDispatchRunId,
  parseRepo,
  readAppCredentials,
  type AppCredentials,
  type OctokitClientOptions,
  type SecretGetter,
} from "./octokit";
export { ZipFormatError, listZipEntries, readZipEntry, type ReadZipEntryOptions, type ZipEntry } from "./zip";
