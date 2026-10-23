// The four agent workflows (DESIGN §4.1, P2-12): who they act as and what they may push.
// Shared by agent-context (before Claude runs) and agent-publish (after it), and by the drift test
// that compares each workflow with its playbook.

export type WorkflowAgent = "developer" | "qa" | "scraper" | "docs";

export const WORKFLOW_AGENTS: readonly WorkflowAgent[] = ["developer", "qa", "scraper", "docs"];

/** Which files an agent's commits may touch (checked before the workflow pushes them). */
export type PushRule = "code" | "tests" | "docs";

export interface AgentConfig {
  agent: WorkflowAgent;
  /** `.github/workflows/<file>` */
  workflow: string;
  /** `docs/agents/<file>`: the playbook holding the tool allowlist. */
  playbook: string;
  /** The App's bot user (git author, PR author or reviewer). Public, not secret. */
  botLogin: string;
  botId: number;
  pushRule: PushRule;
}

export const AGENT_CONFIGS: Readonly<Record<WorkflowAgent, AgentConfig>> = {
  developer: {
    agent: "developer",
    workflow: "agent-developer.yml",
    playbook: "developer.md",
    botLogin: "kentcrosswise-dev[bot]",
    botId: 346713162,
    pushRule: "code",
  },
  qa: {
    agent: "qa",
    workflow: "agent-qa.yml",
    playbook: "qa.md",
    botLogin: "kentcrosswise-qa[bot]",
    botId: 346713513,
    pushRule: "tests",
  },
  scraper: {
    agent: "scraper",
    workflow: "agent-scraper.yml",
    playbook: "scraper.md",
    botLogin: "kentcrosswise-scraper[bot]",
    botId: 346713720,
    pushRule: "code",
  },
  docs: {
    agent: "docs",
    workflow: "agent-docs.yml",
    playbook: "docs.md",
    botLogin: "kentcrosswise-docs[bot]",
    botId: 346713905,
    pushRule: "docs",
  },
};

/** The only account that dispatches agent workflows (`allowed_bots`). */
export const ORCHESTRATOR_BOT_LOGIN = "kentcrosswise-orchestrator[bot]";

export function isWorkflowAgent(x: unknown): x is WorkflowAgent {
  return typeof x === "string" && (WORKFLOW_AGENTS as readonly string[]).includes(x);
}

/** Branch of a task (same as the orchestrator's branchOf). */
export function branchOf(taskId: number): string {
  return `kcw/task-${taskId}`;
}

/** Git author e-mail GitHub links to the bot user. */
export function botEmail(cfg: AgentConfig): string {
  return `${cfg.botId}+${cfg.botLogin}@users.noreply.github.com`;
}

const TEST_PATH = [/(^|\/)test\//, /(^|\/)e2e\//, /\.test\.tsx?$/, /\.e2e\.tsx?$/, /(^|\/)fixtures\//];
const DOCS_PATH = [/^AGENTS\.md$/, /^docs\/DESIGN\.md$/, /^docs\/agents\/[^/]+\.md$/];
/** No agent App has the Workflows permission, and `.claude/**` is owner-only (playbooks). */
const NEVER = [/^\.github\//, /^\.claude\//];

/**
 * Paths of a commit range the rule refuses. `tests` = test files only (QA, playbook: "tests only");
 * `docs` = AGENTS.md, DESIGN.md and playbooks (Docs-keeper playbook); `code` = anything except
 * `.github/**` and `.claude/**`.
 */
export function refusedPaths(rule: PushRule, files: readonly string[]): string[] {
  return files.filter((f) => {
    if (NEVER.some((re) => re.test(f))) return true;
    if (rule === "tests") return !TEST_PATH.some((re) => re.test(f));
    if (rule === "docs") return !DOCS_PATH.some((re) => re.test(f));
    return false;
  });
}
