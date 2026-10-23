// Legacy single-job entrypoints are disabled. The trusted pipeline captures authority
// before work and consumes immutable, bounded data on a fresh publisher runner.
import { runMain } from "./lib/main";
await runMain(async () => { throw new Error("Use scripts/agent-pipeline.ts from the split trusted workflow"); });
