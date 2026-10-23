import { appendFileSync } from "node:fs";
import { exportPublisherPrivateKey } from "./lib/agent-private-key";

try {
  exportPublisherPrivateKey(process.env, {
    stdout: (command) => { process.stdout.write(command); },
    appendEnv: (file, value) => { appendFileSync(file, value, "utf8"); },
  });
} catch {
  // Do not print crypto, filesystem, environment or workflow-command error objects/causes.
  console.error("Publisher App private key preparation failed");
  process.exitCode = 1;
}
