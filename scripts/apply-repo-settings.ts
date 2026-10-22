// Creates or updates the `main` ruleset from scripts/repo-settings/ (DESIGN §4.1, P1-17).
// Owner/Liaison only: needs a token with repo admin rights. NOT run by CI or agents.
// Usage: pnpm apply-repo-settings --profile interim|final [--orchestrator-app-id <id>] [--repo owner/name] [--dry-run]
//   PowerShell:  $env:GH_TOKEN = gh auth token; pnpm apply-repo-settings --profile interim --dry-run
// --dry-run prints the request body and changes nothing. The final profile needs the orchestrator
// App id (P2-07), so kcw/merge-rules can only be satisfied by that App.
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { appIdArg, applyRuleset, checksWithoutSource, fetchRuleset, loadExpected, profileArg, requestBody } from "./lib/repo-settings";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help || args.profile === undefined) {
    console.log("Usage: pnpm apply-repo-settings --profile interim|final [--orchestrator-app-id <id>] [--repo owner/name] [--dry-run]");
    if (!args.help) process.exitCode = 1;
    return;
  }
  const profile = profileArg(args.profile);
  const repo = typeof args.repo === "string" ? args.repo : (process.env.GITHUB_REPOSITORY ?? "kentkodes/kentcrosswise");
  const ruleset = loadExpected(profile, appIdArg(args["orchestrator-app-id"]));
  const unsourced = checksWithoutSource(ruleset);
  if (unsourced.length > 0) {
    throw new Error(`required checks without a source App: ${unsourced.join(", ")}; pass --orchestrator-app-id (or KCW_ORCHESTRATOR_APP_ID)`);
  }
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (args["dry-run"] === true) {
    const existing = await fetchRuleset({ repo, token });
    console.log(`dry run: would ${existing ? `update ruleset ${existing.id}` : "create the ruleset"} on ${repo} with:`);
    console.log(JSON.stringify(requestBody(ruleset), null, 2));
    return;
  }
  if (!token) throw new Error("GH_TOKEN (or GITHUB_TOKEN) with repo admin rights is required");
  const { action, id } = await applyRuleset({ repo, token }, ruleset);
  console.log(`apply-repo-settings: ${action} ruleset ${id} "${ruleset.name}" (${profile}) on ${repo}`);
});
