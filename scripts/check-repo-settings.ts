// Compares the `main` ruleset on GitHub with the expected one (DESIGN §4.1, P1-17).
// Usage: pnpm check-repo-settings [--profile final|interim] [--repo owner/name] [--orchestrator-app-id <id>]
// Env: GITHUB_TOKEN or GH_TOKEN (optional for a public repo; a token with admin read also sees the
//      bypass list); GITHUB_REPOSITORY (default repo); KCW_ORCHESTRATOR_APP_ID.
// Exit 1 on drift. CI runs it as a non-blocking step until Phase 2.
import { parseArgs } from "./lib/args";
import { runMain } from "./lib/main";
import { appIdArg, compareRuleset, fetchRuleset, loadExpected, profileArg } from "./lib/repo-settings";

const args = parseArgs(process.argv.slice(2));

await runMain(async () => {
  if (args.help) {
    console.log("Usage: pnpm check-repo-settings [--profile final|interim] [--repo owner/name] [--orchestrator-app-id <id>]");
    return;
  }
  const profile = profileArg(args.profile);
  const repo = typeof args.repo === "string" ? args.repo : (process.env.GITHUB_REPOSITORY ?? "kentkodes/kentcrosswise");
  const expected = loadExpected(profile, appIdArg(args["orchestrator-app-id"]));
  const actual = await fetchRuleset({ repo, token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN });
  const { drift, warnings } = compareRuleset(expected, actual);
  for (const w of warnings) console.log(`warning: ${w}`);
  if (drift.length > 0) {
    for (const d of drift) console.error(`  drift: ${d}`);
    throw new Error(`${repo}: ruleset "${expected.name}" does not match the ${profile} profile (${drift.length} difference(s))`);
  }
  console.log(`check-repo-settings: ${repo} ruleset "${expected.name}" matches the ${profile} profile`);
});
