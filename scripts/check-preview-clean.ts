// Fails if anything of preview pr-<n> survived the teardown: kcw:pr-tagged resources, kcw-pr-<n>-*
// roles/CloudFront functions/policies/OACs, /kcw/preview/pr-<n>/ parameters, the state and lock
// objects, or the Neon branch preview/pr-<n>.
// Usage: pnpm check-preview-clean --pr <n> [--bucket <state bucket>] [--neon-project <id>] [--skip-neon]
// Env: AWS credentials (kcw-gh-ci or the owner's profile); TF_STATE_BUCKET; NEON_CI_PROJECT_ID;
//      NEON_API_KEY or KCW_CI_NEON_API_KEY (as exported by aws-secretsmanager-get-secrets).
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { awsPreviewProbe, findPreviewLeftovers } from "./lib/preview-clean";

const args = parseArgs(process.argv.slice(2));

function str(name: string): string | undefined {
  const v = args[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

await runMain(async () => {
  if (args.help) {
    console.log("Usage: pnpm check-preview-clean --pr <n> [--bucket <state bucket>] [--neon-project <id>] [--skip-neon]");
    return;
  }
  const prRaw = str("pr");
  if (prRaw === undefined || !/^(0|[1-9][0-9]*)$/.test(prRaw)) throw new Error("--pr <n> is required");
  const pr = Number(prRaw);
  const stateBucket = str("bucket") ?? process.env.TF_STATE_BUCKET;
  if (!stateBucket) throw new Error("--bucket or TF_STATE_BUCKET is required");
  const skipNeon = args["skip-neon"] === true;
  const projectId = str("neon-project") ?? process.env.NEON_CI_PROJECT_ID;
  const apiKey = process.env.NEON_API_KEY ?? process.env.KCW_CI_NEON_API_KEY;
  if (!skipNeon && (!projectId || !apiKey)) {
    throw new Error("Neon check needs --neon-project (or NEON_CI_PROJECT_ID) and NEON_API_KEY; or pass --skip-neon");
  }

  const probe = awsPreviewProbe({
    region: process.env.AWS_REGION ?? "us-east-1",
    neon: projectId && apiKey ? { projectId, apiKey } : undefined,
  });
  const leftovers = await findPreviewLeftovers(probe, { pr, stateBucket, skipNeon });
  if (leftovers.length > 0) {
    for (const l of leftovers) console.error(`  ${l}`);
    throw new Error(`preview pr-${pr} is not clean (${leftovers.length} leftover${leftovers.length === 1 ? "" : "s"})`);
  }
  console.log(`check-preview-clean: pr-${pr} is clean${skipNeon ? " (Neon not checked)" : ""}`);
});
