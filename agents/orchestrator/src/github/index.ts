// @kcw/orchestrator/github (P2-09): the orchestrator's GitHub client.
export * from "./types";
export { FakeGitHubClient, type FakeCheck, type FakeMethod, type FakePr } from "./fake";
export {
  APP_SECRET_KEYS,
  MAX_ARTIFACT_BYTES,
  OctokitGitHubClient,
  createAppOctokit,
  createOctokitGitHubClient,
  githubClientFromSecret,
  parseRepo,
  readAppCredentials,
  type AppCredentials,
  type OctokitClientOptions,
  type SecretGetter,
} from "./octokit";
export { ZipFormatError, listZipEntries, readZipEntry, type ReadZipEntryOptions, type ZipEntry } from "./zip";
