/** Package name, used by the workspace smoke test. */
export const PACKAGE_NAME = "@kcw/essays";

// E5 source registry and watcher building blocks (docs/essays/E5-DESIGN.md).
export { canonicalizeUrl, urlHash } from "./crawl/canonical";
export {
  RobotsCache,
  interpretRobots,
  parseRobots,
  productToken,
  robotsAllows,
  robotsCrawlDelayMs,
  type RobotsFetch,
  type RobotsPolicy,
} from "./crawl/robots";
export {
  DEFAULT_USER_AGENT,
  createHttpClient,
  fetchRobotsTxt,
  looksLikeLoginUrl,
  type HttpClient,
  type HttpFailure,
  type HttpResult,
} from "./crawl/http";
export { claimFetchSlot, noteRetryAfter, waitForFetchSlot, type SlotResult } from "./crawl/lease";
export { createPoliteClient } from "./crawl/polite";
export type { Db } from "./db";
export {
  loadRunnableSources,
  loadSource,
  loadSources,
  parseCrawlRules,
  sourceAllows,
  type SourceRecord,
} from "./registry/source";
export { nextHealth, recordOutcome, recordSourceEvent, type HealthEvent, type UrlOutcome } from "./registry/health";
