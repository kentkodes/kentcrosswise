// Generates the Web Push VAPID keys and patches them into a secret (keys vapid_public, vapid_private).
// Prints only a fixed success line, never a key. Refuses to overwrite existing keys unless --rotate.
// Usage: pnpm exec tsx scripts/vapid-keys.ts --secret kcw/prod/web [--rotate]
import { defaultSecretStore } from "@kcw/secrets";
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { writeVapidKeys } from "./lib/vapid-keys";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log("Usage: pnpm exec tsx scripts/vapid-keys.ts --secret <name> [--rotate]");
    return;
  }
  if (typeof args.secret !== "string" || args.secret === "") throw new Error("--secret <name> is required");
  console.log(await writeVapidKeys(defaultSecretStore(), args.secret, { rotate: args.rotate === true }));
});
