// @kcw/orchestrator. The Lambda entry is src/lambda.ts (`handler`, still the P2-08 skeleton graph).
// The task graph (P2-10) is `@kcw/orchestrator/graph`; the GitHub client is `@kcw/orchestrator/github`.
export const PACKAGE_NAME = "@kcw/orchestrator";

export {
  CHECKPOINT_SCHEMA,
  CheckpointSchemaMissingError,
  checkpointerFromPool,
  createPool,
  setupCheckpointer,
} from "./checkpointer";
export { TaskState, buildGraph, type TaskGraph, type TaskStateValues, type WaitRequest, type WaitingOn } from "./skeleton";
export {
  InputError,
  handleRecords,
  handleSqsEvent,
  parseMessage,
  processInput,
  threadConfig,
  type HandlerDeps,
  type OrchestratorInput,
  type Outcome,
  type SqsBatchResponse,
  type SqsEvent,
  type SqsRecord,
  type TaskCreatedMessage,
} from "./handler";
export {
  ConfigError,
  MODELS_SECRET_ENV,
  ORCHESTRATOR_SECRET_ENV,
  createHandler,
  type LambdaDeps,
  type SecretReader,
} from "./lambda";
