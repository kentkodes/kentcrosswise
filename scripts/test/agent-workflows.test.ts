import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKFLOW_AGENTS } from "../lib/agents";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8").replace(/\r/g, "");
function jobs(yml: string): Record<string, string> {
  const chunks = yml.split(/^ {2}([a-z]+):\n/gm);
  const out: Record<string,string> = {};
  for(let i=1;i<chunks.length;i+=2) if(chunks[i+1]?.includes("runs-on:")) out[chunks[i]!] = chunks[i+1]!;
  return out;
}
const tools = (s: string) => s.replace(/\s+/g," ").trim().split(",").map(s=>s.trim());
describe.each(WORKFLOW_AGENTS)("isolated %s workflow", (agent) => {
  const yml=read(`.github/workflows/agent-${agent}.yml`), job=jobs(yml);
  it("separates public prepare, work and privileged publish/report runners",()=>{
    expect(Object.keys(job)).toEqual(agent==='qa' ? ['prepare','start','work','review','publish','report'] : ['prepare','start','work','publish','report']);
    expect(yml).toMatch(/^permissions: \{\}$/m);
    expect(job.prepare).toContain("vars.KCW_AGENT_WORKFLOWS_ENABLED == 'true'");
    for(const name of ['start','publish','report']) {
      expect(job[name]).toContain(`environment: agent-publish-${agent}`);
      expect(job[name]).toContain(`vars.AWS_ROLE_AGENT_${agent.toUpperCase()}_ARN`);
      expect(job[name]).toContain(`--command guard --agent ${agent}`);
      expect(job[name]!.indexOf('--command guard')).toBeLessThan(job[name]!.indexOf('uses: aws-actions/configure-aws-credentials'));
      expect(job[name]).not.toMatch(/path: payload|ref: main|--dir payload|--source|execution_file/);
    }
    expect(yml).not.toContain('AWS_ROLE_AGENT_ARN');
    expect(job.work).not.toMatch(/environment:|aws-actions|create-github-app-token|KCW_APP|AWS_ROLE|AWS_ACCESS_KEY|kcw-report/);
    expect(job.prepare).not.toMatch(/id-token: write|aws-actions|create-github-app-token/);
  });
  it("pins all trusted source and avoids caches and lifecycle scripts before privilege",()=>{
    expect(yml).not.toMatch(/uses: actions\/cache|cache: true|ref: main|uses: \.\//);
    expect(yml).not.toMatch(/pnpm exec tsx (?!--tsconfig scripts\/tsconfig\.json)/);
    for (const name of Object.keys(job)) {
      expect(job[name]).toContain('ref: ${{ github.sha }}');
      expect(job[name]).toContain('persist-credentials: false');
      expect(job[name]).toContain('pnpm install --frozen-lockfile --ignore-scripts');
    }
    expect(job.publish).not.toContain('pnpm install --frozen-lockfile\n');
    expect(job.report).not.toContain('pnpm install --frozen-lockfile\n');
  });
  it("consumes explicit job-produced immutable artifact ids and no artifact-name fallback",()=>{
    const downloads=[...yml.matchAll(/uses: actions\/download-artifact@[^]*?(?= {6}-|$)/g)].map(m=>m[0]);
    expect(downloads.length).toBeGreaterThanOrEqual(4);
    for(const d of downloads) {
      expect(d).toMatch(/artifact-ids: \$\{\{ needs\.(prepare|work|review)\.outputs\.artifact_id \}\}/);
      expect(d).not.toMatch(/\n +name:|pattern:/);
    }
    expect(job.work).toContain('--command sanitize');
    expect(job.publish).toContain('--command publish');
    expect(job.report).toContain('if: always()');
    expect(yml).not.toContain('--claude-execution-file');
    expect(yml).not.toContain('--minutes');
  });
  it("keeps the work model tools aligned with the canonical role",()=>{
    const workTools=/--allowedTools "([^"]*)"/.exec(job.work!)?.[1];
    const roleTools=/## Tool allowlist[^]*?```\s*([^]*?)```/.exec(read(`docs/agents/${agent}.md`))?.[1];
    expect(workTools).toBeTruthy(); expect(tools(workTools!)).toEqual(tools(roleTools!));
    expect(workTools).not.toMatch(/git push|Bash\((?:aws|gh|curl|wget|node:\*)/);
    expect(job.work).toContain('github_token: ${{ github.token }}');
    expect(job.work).toContain('anthropic_federation_rule_id:');
    expect(job.work).toContain('--model claude-haiku-5-5');
  });
  if(agent==='docs') it("checks the edited payload documentation instead of the trusted root",()=>{
    expect(job.work).toContain('Bash(node payload/scripts/check-agent-docs.mjs)');
    expect(job.work).not.toContain('Bash(node scripts/check-agent-docs.mjs)');
    const playbook=read('docs/agents/docs.md');
    expect(playbook).toContain('node payload/scripts/check-agent-docs.mjs');
    expect(playbook).toContain('report the capability gap');
  });
  if(agent==='qa' || agent==='docs') it("publishes without an unsupported Issues permission",()=>{
    expect(job.publish).not.toContain('permission-issues:');
    expect(job.publish).toContain('permission-contents: write');
    expect(job.publish).toContain('permission-pull-requests: write');
  });
  if(agent==='qa') it("makes the final decision on a fresh runner with no PR execution or write tools",()=>{
    expect(job.review).toContain('--command review-input');
    expect(job.review).toContain('--command review-output');
    expect(job.review).not.toMatch(/pnpm --dir payload|Bash\(pnpm|Edit,|Write,|aws-actions|create-github-app-token/);
    expect(job.review).toContain('diff --no-ext-diff --no-textconv');
    expect(job.publish).toContain('needs: [prepare, work, review]');
  });
});
