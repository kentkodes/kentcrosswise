// P2-12: the four agent workflows follow DESIGN §4.1, and each tool allowlist is the same in the
// workflow (which grants it) and in the playbook (which documents it). No YAML parser is a
// dependency, so the workflows are read as text; the patterns rely on their fixed layout.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT_CONFIGS, ORCHESTRATOR_BOT_LOGIN, WORKFLOW_AGENTS, type WorkflowAgent } from "../lib/agents";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf8").replace(/\r\n/g, "\n");

function splitTools(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** `--allowedTools "..."` of the workflow's claude_args (folded YAML: lines join with spaces). */
function workflowTools(yml: string): string[] {
  const all = [...yml.matchAll(/--allowedTools "([^"]*)"/g)];
  if (all.length !== 1) throw new Error(`expected one --allowedTools, found ${all.length}`);
  return splitTools(all[0]![1]!);
}

/** The fenced block under "## Tool allowlist" in a playbook. */
function playbookTools(md: string): string[] {
  const m = /^## Tool allowlist[^\n]*\n[\s\S]*?^```\n([\s\S]*?)^```/m.exec(md);
  if (!m) throw new Error("no ## Tool allowlist code block");
  return splitTools(m[1]!);
}

/** Lines of a block that starts at `header` (exact line) and ends at the first line indented less or equal. */
function block(yml: string, header: RegExp): string[] {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => header.test(l));
  if (start < 0) throw new Error(`no block ${header}`);
  const indent = lines[start]!.search(/\S/);
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === "") continue;
    if (l.search(/\S/) <= indent) break;
    out.push(l);
  }
  return out;
}

/** The `with:` lines of the (single) claude-code-action step. */
function claudeWith(yml: string): string[] {
  const lines = yml.split("\n");
  const uses = lines.findIndex((l) => l === "        uses: anthropics/claude-code-action@v1");
  if (uses < 0 || lines[uses + 1] !== "        with:") throw new Error("no claude-code-action step with a with: block");
  const out: string[] = [];
  for (const l of lines.slice(uses + 2)) {
    if (l.trim() !== "" && l.search(/\S/) <= 8) break;
    out.push(l);
  }
  return out;
}

/** Keys of a mapping block at exactly `indent` spaces. */
function keys(lines: string[], indent: number): string[] {
  return lines.filter((l) => l.search(/\S/) === indent && /^\s*[\w-]+:/.test(l)).map((l) => l.trim().split(":")[0]!);
}

// Inputs of anthropics/claude-code-action@v1 (action.yml at tag v1, read 2026-10-23).
const CLAUDE_ACTION_INPUTS = new Set([
  "trigger_phrase", "assignee_trigger", "label_trigger", "base_branch", "branch_prefix", "branch_name_template",
  "allowed_bots", "allowed_non_write_users", "include_comments_by_actor", "exclude_comments_by_actor", "prompt",
  "settings", "anthropic_api_key", "claude_code_oauth_token", "anthropic_federation_rule_id",
  "anthropic_organization_id", "anthropic_service_account_id", "anthropic_workspace_id", "anthropic_oidc_audience",
  "github_token", "use_bedrock", "use_vertex", "use_foundry", "claude_args", "additional_permissions",
  "use_sticky_comment", "classify_inline_comments", "use_commit_signing", "ssh_signing_key", "bot_id", "bot_name",
  "track_progress", "include_fix_links", "path_to_claude_code_executable", "path_to_bun_executable",
  "display_report", "show_full_output", "plugins", "plugin_marketplaces",
]);

const EXPECTED_INPUTS: Record<WorkflowAgent, string[]> = {
  developer: ["task_id", "issue", "mode", "pr"],
  scraper: ["task_id", "issue", "mode", "pr"],
  qa: ["task_id", "pr"],
  docs: ["task_id", "pr"],
};

const CLIENT_ID_VAR: Record<WorkflowAgent, string> = {
  developer: "DEV_APP_CLIENT_ID",
  qa: "QA_APP_CLIENT_ID",
  scraper: "SCRAPER_APP_CLIENT_ID",
  docs: "DOCS_APP_CLIENT_ID",
};

describe.each(WORKFLOW_AGENTS)("agent workflow: %s", (agent) => {
  const cfg = AGENT_CONFIGS[agent];
  const yml = read(`.github/workflows/${cfg.workflow}`);
  const playbook = read(`docs/agents/${cfg.playbook}`);

  it("grants exactly the tools its playbook lists", () => {
    const tools = workflowTools(yml);
    expect(tools).toEqual(playbookTools(playbook));
    expect(new Set(tools).size).toBe(tools.length);
    // Pushing is the workflow's job (with the App token), never Claude's.
    expect(tools.filter((t) => /git (-C \S+ )?push|git switch|\bgh\b|\baws\b|curl|wget/.test(t))).toEqual([]);
  });

  it("is dispatch-only, with the inputs of DESIGN §4.1", () => {
    expect(keys(block(yml, /^on:$/), 2)).toEqual(["workflow_dispatch"]);
    expect(keys(block(yml, /^ {4}inputs:$/), 6)).toEqual(EXPECTED_INPUTS[agent]);
  });

  it("has no top-level permissions and the job gets id-token: write, contents: read only", () => {
    expect(yml).toMatch(/^permissions: \{\}$/m);
    const perms = block(yml, /^ {4}permissions:$/).map((l) => l.trim());
    expect(perms).toEqual(["id-token: write", "contents: read"]);
    expect(yml).toMatch(/^ {4}timeout-minutes: 50$/m);
    expect(yml).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
  });

  it("follows the auth pattern with pinned major versions and only this agent's secret", () => {
    const uses = [...yml.matchAll(/uses: (\S+)/g)].map((m) => m[1]!);
    expect(uses.filter((u) => !u.startsWith("./"))).toEqual([
      "aws-actions/configure-aws-credentials@v6.3.0",
      "aws-actions/aws-secretsmanager-get-secrets@v3",
      "actions/create-github-app-token@v3",
      "actions/checkout@v7",
      ...(agent === "qa" ? ["actions/checkout@v7"] : []),
      "anthropics/claude-code-action@v1",
    ]);
    expect(yml).toContain("role-to-assume: ${{ vars.AWS_ROLE_AGENT_ARN }}");
    expect(yml).toContain("output-env-credentials: false");
    expect([...new Set([...yml.matchAll(/kcw\/github\/[\w-]+/g)].map((m) => m[0]))]).toEqual([`kcw/github/${agent}-app`]);
    expect(yml).toContain(`KCW_APP, kcw/github/${agent}-app`);
    expect(yml).toContain(`client-id: \${{ vars.${CLIENT_ID_VAR[agent]} }}`);
    expect(yml).toMatch(/echo "KCW_APP_PRIVATE_KEY=" >> "\$GITHUB_ENV"/);
    expect(yml).not.toMatch(/persist-credentials: true/);
  });

  it("runs Claude Code Action with federation, Haiku 5.5, the agent bot and no secret output", () => {
    const withBlock = claudeWith(yml);
    const inputs = keys(withBlock, 10);
    expect(inputs.length).toBeGreaterThan(10);
    for (const k of inputs) expect(CLAUDE_ACTION_INPUTS, `unknown claude-code-action input ${k}`).toContain(k);
    const text = withBlock.join("\n");
    expect(text).toContain("anthropic_federation_rule_id: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}");
    expect(text).toContain("anthropic_organization_id: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}");
    expect(text).not.toMatch(/anthropic_api_key|claude_code_oauth_token|secrets\./);
    expect(text).toContain(`allowed_bots: ${ORCHESTRATOR_BOT_LOGIN}`);
    expect(text).toContain(`bot_id: "${cfg.botId}"`);
    expect(text).toContain(`bot_name: ${cfg.botLogin}`);
    expect(text).toContain("github_token: ${{ github.token }}");
    expect(text).toMatch(/^ +show_full_output: false$/m);
    expect(text).toMatch(/^ +display_report: false$/m);
    expect(text).toMatch(/^ +plugins: /m);
    expect(text).toMatch(/^ +plugin_marketplaces: /m);
    expect(text).toMatch(/--model claude-haiku-5-5\n\s+--max-turns [1-9][0-9]*\n/);
  });

  it("reports with kcw-report, on failure too, and never sends Actions minutes (Q13)", () => {
    expect(yml).not.toMatch(/--minutes/);
    expect(yml).toMatch(/if: always\(\) && steps\.aws\.outcome == 'success'/);
    expect(yml).toContain(`--agent ${agent} --event-type "$EVENT"`);
    expect(yml).toContain("--claude-execution-file");
  });

  it("publishes with the agent's own push rule", () => {
    expect(yml).toContain(`pnpm -s agent-publish --agent ${agent} `);
    expect(yml).toContain(`pnpm -s agent-context --agent ${agent} `);
  });
});

describe("QA trusted config", () => {
  const yml = read(".github/workflows/agent-qa.yml");
  it("checks out main at the root and the PR head in pr-head/ without agent config", () => {
    expect(yml).toMatch(/uses: actions\/checkout@v7\n\s+with:\n\s+ref: main\n/);
    const head = block(yml, /^ {6}- name: Checkout the PR head \(data\)$/).join("\n");
    expect(head).toContain("path: pr-head");
    expect(head).toContain("ref: ${{ steps.ctx.outputs.head_sha }}");
    for (const p of ["!CLAUDE.md", "!CLAUDE.local.md", "!.claude/", "!.mcp.json"]) expect(head).toContain(p);
  });
});

describe("text helpers", () => {
  it("split folded allowlists on commas only", () => {
    expect(workflowTools('--allowedTools "Read, Bash(pnpm vitest run:*),\n  Bash(git status)"')).toEqual([
      "Read",
      "Bash(pnpm vitest run:*)",
      "Bash(git status)",
    ]);
    expect(playbookTools("## Tool allowlist (v9)\n\ntext\n\n```\nA, B,\nC\n```\n")).toEqual(["A", "B", "C"]);
    expect(() => playbookTools("## Bash allowlist\n```\nA\n```\n")).toThrow();
  });
});
