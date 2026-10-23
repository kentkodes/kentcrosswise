// Sweeper Lambda entry point (handler `index.handler` once bundled by `pnpm build-lambdas`;
// infra/modules/scheduler). Production wiring of createSweeperHandler: AWS SDK SQS client and
// Secrets Manager. Nothing runs at import time besides creating the clients.
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SecretStore } from "@kcw/secrets";
import { createSweeperHandler } from "./lambda";

const sqs = new SQSClient({});

export const handler = createSweeperHandler({
  env: process.env,
  secrets: new SecretStore(),
  sendMessage: (input) => sqs.send(new SendMessageCommand(input)),
});
