import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { candidateBundle, parseTrustedContext, readAdvisoryUsage, requireArtifact, requireCodeProgress, requireLivePull, requirePublisherEnvironment, restoreTrustedInstructions, stripInstructions } from "../lib/agent-pipeline";
import { checkAgentDocs } from "../check-agent-docs.mjs";
const sha = "a".repeat(40);
const context = { version: 1, agent: "qa", repo: "owner/repo", taskId: 2, issue: null, pr: 12, branch: "kcw/task-2", baseSha: sha, remoteSha: sha, workflowSha: sha };
const dirs: string[] = [];
const dir = () => { const p=mkdtempSync(path.join(tmpdir(),"kcw-boundary-")); dirs.push(p); return p; };
afterEach(() => { for(const p of dirs.splice(0)) rmSync(p,{recursive:true,force:true}); vi.unstubAllEnvs(); });
const gh = (values: unknown[]) => ({ repo: "owner/repo", token: "synthetic", fetch: vi.fn(async () => Response.json(values.shift())) as unknown as typeof fetch });
describe("trusted authority",()=>{
  it("fails empty code tasks while allowing validated PR retries and docs no-op",()=>{
    for(const agent of ["developer", "scraper"] as const) {
      const c=parseTrustedContext(JSON.stringify({...context,agent,pr:null}));
      expect(()=>requireCodeProgress(c,false)).toThrow(/no commits/);
      expect(()=>requireCodeProgress(c,true)).not.toThrow();
      expect(()=>requireCodeProgress({...c,pr:12},false)).not.toThrow();
    }
    expect(()=>requireCodeProgress(parseTrustedContext(JSON.stringify({...context,agent:"docs"})),false)).not.toThrow();
  });
  it("rejects work fields, changed role schema, traversal branch and malformed baseline",()=>{
    expect(parseTrustedContext(JSON.stringify(context))).toEqual(context);
    for(const change of [{ extra:true },{baseSha:"HEAD"},{branch:"kcw/task-3"},{agent:"owner"},{taskId:0},{repo:"https://other/repo"}])
      expect(()=>parseTrustedContext(JSON.stringify({...context,...change}))).toThrow();
  });
  it("requires exactly main branch deployment policy before credentials",async()=>{
    await expect(requirePublisherEnvironment(gh([{deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}},{total_count:1,branch_policies:[{name:"main",type:"branch"}]}]),"qa")).resolves.toBeUndefined();
    for(const rules of [[{name:"*",type:"branch"}],[{name:"main",type:"tag"}],[{name:"main",type:"branch"},{name:"task-*",type:"branch"}]])
      await expect(requirePublisherEnvironment(gh([{deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}},{total_count:rules.length,branch_policies:rules}]),"qa")).rejects.toThrow();
  });
  it("rejects empty/foreign artifact IDs before download, and checks run+SHA+purpose",async()=>{
    const api=gh([]);
    await expect(requireArtifact(api,"","candidate-1","1")).rejects.toThrow();
    expect(api.fetch).not.toHaveBeenCalled();
    vi.stubEnv("GITHUB_SHA",sha);
    const art={id:4,name:"candidate-1",expired:false,size_in_bytes:100,workflow_run:{id:1,head_sha:sha}};
    await expect(requireArtifact(gh([art]),"4","candidate-1","1")).resolves.toBeUndefined();
    for(const change of [{name:"other"},{workflow_run:{id:2,head_sha:sha}},{expired:true},{size_in_bytes:30*1024*1024}])
      await expect(requireArtifact(gh([{...art,...change}]),"4","candidate-1","1")).rejects.toThrow();
  });
  it("binds exact PR repo/base/branch/head and CI producer SHA immediately before review",async()=>{
    const pull={state:"open",head:{repo:{full_name:"owner/repo"},ref:"kcw/task-2",sha},base:{ref:"main"}};
    const check={name:"ci/required",head_sha:sha,app:{slug:"github-actions"},status:"completed",conclusion:"success"};
    const c=parseTrustedContext(JSON.stringify(context));
    await expect(requireLivePull(gh([pull,{total_count:1,check_runs:[check]}]),c,sha,true)).resolves.toEqual(pull);
    for(const changed of [{...pull,base:{ref:"other"}},{...pull,head:{...pull.head,sha:"b".repeat(40)}}])
      await expect(requireLivePull(gh([changed]),c,sha,true)).rejects.toThrow();
    for(const changed of [{...check,conclusion:"failure"},{...check,head_sha:"b".repeat(40)},{...check,app:{slug:"other"}}])
      await expect(requireLivePull(gh([pull,{total_count:1,check_runs:[changed]}]),c,sha,true)).rejects.toThrow();
  });
});
describe("untrusted files",()=>{
  it("restores pinned trusted guidance so payload documentation tests remain runnable",()=>{
    const root=dir(), trusted=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
    for(const file of ["docs","AGENTS.md","CLAUDE.md","GEMINI.md","apps/web/AGENTS.md","agents/merge-rules/approved-deps.json"])
      cpSync(path.join(trusted,file),path.join(root,file),{recursive:true});
    rmSync(path.join(root,"docs/runbooks/agent-security-cutover.md"));
    const taskHandoff=readFileSync(path.join(root,"docs/HANDOFF.md"),"utf8")+"\nPublic task observation retained.\n";
    writeFileSync(path.join(root,"docs/HANDOFF.md"),taskHandoff);
    writeFileSync(path.join(root,"AGENTS.md"),"untrusted task instructions");
    mkdirSync(path.join(root,"nested/.claude"),{recursive:true});
    writeFileSync(path.join(root,"nested/.claude/settings.json"),"{}");
    stripInstructions(root);
    expect(checkAgentDocs(root)).toContain("AGENTS.md: missing file");
    const restored=restoreTrustedInstructions(root,trusted);
    expect(restored).toContain("apps/web/AGENTS.md");
    expect(restored).toContain("docs/runbooks/agent-security-cutover.md");
    expect(readFileSync(path.join(root,"docs/HANDOFF.md"),"utf8")).toBe(taskHandoff);
    expect(readFileSync(path.join(root,"AGENTS.md"),"utf8")).toBe(readFileSync(path.join(trusted,"AGENTS.md"),"utf8"));
    expect(existsSync(path.join(root,"nested/.claude"))).toBe(false);
    expect(checkAgentDocs(root)).toEqual([]);
    rmSync(path.join(root,"docs/HANDOFF.md"));
    expect(restoreTrustedInstructions(root,trusted)).toContain("docs/HANDOFF.md");
    expect(checkAgentDocs(root)).toEqual([]);
  });
  it("strips root and nested native/neutral instructions while retaining source",()=>{
    const root=dir();
    const files=["AGENTS.md","nested/AGENTS.override.md","nested/CLAUDE.local.md","nested/.claude.json","nested/.agents/skill.md","nested/.codex/config.toml","docs/agents/INSTRUCTIONS.md","apps/web/AGENTS.md"];
    for(const f of [...files,"apps/web/src/page.ts"]) { const p=path.join(root,f); mkdirSync(path.dirname(p),{recursive:true});writeFileSync(p,"data"); }
    stripInstructions(root);
    for(const f of files) expect(existsSync(path.join(root,f))).toBe(false);
    expect(readFileSync(path.join(root,"apps/web/src/page.ts"),"utf8")).toBe("data");
  });
  it("refuses surprise artifact files and drops malformed advisory usage without suppressing lifecycle",()=>{
    const root=dir(); writeFileSync(path.join(root,"candidate.bundle"),"KCW_UNCHANGED_V1\n"); writeFileSync(path.join(root,"usage.json"),"[]");
    expect(candidateBundle(root)).toContain("candidate.bundle");
    const usage=[{kind:"model",provider:"anthropic",model:"claude-haiku-5-5",input_tokens:1,output_tokens:2}];
    writeFileSync(path.join(root,"usage.json"),JSON.stringify(usage)); expect(readAdvisoryUsage(root)).toEqual(usage);
    for(const text of ["not json",JSON.stringify([{...usage[0],input_tokens:1e20}]),JSON.stringify([{...usage[0],secret:"unexpected"}])]) {
      writeFileSync(path.join(root,"usage.json"),text);expect(readAdvisoryUsage(root)).toEqual([]);
    }
    writeFileSync(path.join(root,"evil.ts"),"throw 1"); expect(()=>candidateBundle(root)).toThrow(); expect(readAdvisoryUsage(root)).toEqual([]);
    expect(readAdvisoryUsage(path.join(root,"missing"))).toEqual([]);
  });
});
