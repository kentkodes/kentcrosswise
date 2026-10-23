// @kcw/orchestrator. The Lambda entry is src/lambda.ts (`handler`: the task graph of P2-10 with the
// P2-11 planner). The task graph is `@kcw/orchestrator/graph`; the GitHub client is
// `@kcw/orchestrator/github`; the planner and public-title nodes are `@kcw/orchestrator/nodes`.
export const PACKAGE_NAME = "@kcw/orchestrator";

export {
  CHECKPOINT_SCHEMA,
  CheckpointSchemaMissingError,
  checkpointerFromPool,
  createPool,
  setupCheckpointer,
} from "./checkpointer";
export {
  InputError,
  handleRecords,
  threadConfig,
  type SqsBatchResponse,
  type SqsEvent,
  type SqsRecord,
  type TaskCreatedMessage,
} from "./handler";
export {
  ANTHROPIC_KEY,
  ConfigError,
  MODELS_SECRET_ENV,
  ORCHESTRATOR_SECRET_ENV,
  createHandler,
  type LambdaDeps,
  type SecretReader,
} from "./lambda";
