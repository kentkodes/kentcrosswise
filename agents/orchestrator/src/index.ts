// @kcw/orchestrator (P2-08 skeleton). The Lambda entry is src/lambda.ts (`handler`).
export const PACKAGE_NAME = "@kcw/orchestrator";

export {
  CHECKPOINT_SCHEMA,
  CheckpointSchemaMissingError,
  checkpointerFromPool,
  createPool,
  setupCheckpointer,
} from "./checkpointer";
export { TaskState, buildGraph, type TaskGraph, type TaskStateValues, type WaitRequest, type WaitingOn } from "./graph";
export {
  InputError,
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
export { MODELS_SECRET_ENV, ORCHESTRATOR_SECRET_ENV, createHandler, type LambdaDeps, type SecretReader } from "./lambda";
