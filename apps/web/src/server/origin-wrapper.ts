// OpenNext wrapper override for the server function (open-next.config.ts): OpenNext's own
// aws-lambda wrapper, behind the origin header check of ./origin-verify (D25).
import { defaultSecretStore } from "@kcw/secrets";
import awsLambdaWrapper from "@opennextjs/aws/overrides/wrappers/aws-lambda.js";
import { type JobRegistry, jobs } from "./jobs";
import { createOriginGuard, guardHandler } from "./origin-verify";

type Handler = (event: unknown, ...rest: unknown[]) => Promise<unknown>;
interface BaseWrapper {
  wrapper: (handler: unknown, converter: unknown) => Promise<Handler>;
  name: string;
  supportStreaming: boolean;
}

const base = awsLambdaWrapper as unknown as BaseWrapper;

/**
 * A scheduled job payload: a plain object with a string `kcw_job` and none of the keys
 * Lambda puts on a Function URL event (`requestContext`, `headers`, `rawPath`). An HTTP caller
 * controls only headers, body and query, so it cannot produce one.
 */
export function isJobEvent(event: unknown): event is { kcw_job: string; scheduled_time?: unknown } {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
  if (Object.getPrototypeOf(event) !== Object.prototype) return false;
  if ("requestContext" in event || "headers" in event || "rawPath" in event) return false;
  return typeof (event as { kcw_job?: unknown }).kcw_job === "string";
}

async function runJobEvent(event: { kcw_job: string; scheduled_time?: unknown }, registry: JobRegistry) {
  const job = event.kcw_job;
  // Only registry names run; anything else is refused without running anything.
  if (!Object.hasOwn(registry, job)) return { code: "unknown_job" };
  try {
    const scheduledTime = typeof event.scheduled_time === "string" ? event.scheduled_time : undefined;
    const outcome = await registry[job]!({ scheduledTime });
    return { job, code: outcome.code, counts: outcome.counts ?? {} };
  } catch (err) {
    // Class name only: error messages can carry private text.
    console.error(`[job] ${job} failed ${err instanceof Error ? err.constructor.name : "NonError"}`);
    throw err;
  }
}

export function originGuardedWrapper(
  baseWrapper: BaseWrapper = base,
  env: Readonly<Record<string, string | undefined>> = process.env,
  registry: JobRegistry = jobs,
): BaseWrapper {
  const guard = createOriginGuard({
    env,
    loadSecret: (name, key) =>
      key === undefined
        ? defaultSecretStore().get(name).then((v) => (typeof v === "string" ? v : ""))
        : defaultSecretStore().get(name, key),
  });
  return {
    name: "kcw-origin-guard",
    supportStreaming: baseWrapper.supportStreaming,
    wrapper: async (handler, converter) => {
      const guarded = guardHandler(await baseWrapper.wrapper(handler, converter), guard);
      // Job payloads are routed before the origin check and the OpenNext handler; everything else
      // (every HTTP request) takes the guarded path unchanged.
      return (event, ...rest) => (isJobEvent(event) ? runJobEvent(event, registry) : guarded(event, ...rest));
    },
  };
}

export default originGuardedWrapper();
