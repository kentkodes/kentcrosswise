// OpenNext v4 build config (D14). The output layout is the contract for infra/modules/web;
// see "OpenNext output contract" in AGENTS.md before changing anything here.
import type { OpenNextConfig } from "@opennextjs/aws/types/open-next.js";

const config = {
  default: {
    override: {
      // Lambda Function URL events use the API Gateway v2 payload format.
      wrapper: "aws-lambda",
      converter: "aws-apigw-v2",
      // ISR/data cache in the assets bucket under _cache/ (aws4fetch, no AWS SDK in the bundle).
      incrementalCache: "s3-lite",
      // Time-based ISR revalidation goes through an SQS FIFO queue to the revalidation function.
      queue: "sqs-lite",
      // No DynamoDB: revalidateTag/revalidatePath are not used yet. Revisit before adding them.
      tagCache: "dummy",
    },
  },
  imageOptimization: {
    // Source images are read from the assets bucket under _assets/.
    loader: "s3-lite",
    // sharp for Lambda arm64 (OpenNext's default version); scripts/build-web.ts installs it on Windows.
    install: { packages: ["sharp@0.35.5"], arch: "arm64" },
  },
  dangerous: {
    disableTagCache: true,
  },
} satisfies OpenNextConfig;

export default config;
