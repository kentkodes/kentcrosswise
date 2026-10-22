// OpenNext wrapper override for the server function (open-next.config.ts): OpenNext's own
// aws-lambda wrapper, behind the origin header check of ./origin-verify (D25).
import { defaultSecretStore } from "@kcw/secrets";
import awsLambdaWrapper from "@opennextjs/aws/overrides/wrappers/aws-lambda.js";
import { createOriginGuard, guardHandler } from "./origin-verify";

type Handler = (event: unknown, ...rest: unknown[]) => Promise<unknown>;
interface BaseWrapper {
  wrapper: (handler: unknown, converter: unknown) => Promise<Handler>;
  name: string;
  supportStreaming: boolean;
}

const base = awsLambdaWrapper as unknown as BaseWrapper;

export function originGuardedWrapper(
  baseWrapper: BaseWrapper = base,
  env: Readonly<Record<string, string | undefined>> = process.env,
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
    wrapper: async (handler, converter) => guardHandler(await baseWrapper.wrapper(handler, converter), guard),
  };
}

export default originGuardedWrapper();
