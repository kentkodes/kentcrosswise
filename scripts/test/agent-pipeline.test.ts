import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAgentReport } from "@kcw/core/events";
import { createHash } from "node:crypto";
import { canonicalContract, type TaskContract } from "@kcw/core/contract";
import { buildReport, candidateBundle, parseTrustedContext, prepareContext, readContract, requireContractIssue, readAdvisoryUsage, requireArtifact, requireCodeProgress, requireLivePull, requirePublisherEnvironment, restoreTrustedInstructions, stripInstructions } from "../lib/agent-pipeline";
import { checkAgentDocs } from "../check-agent-docs.mjs";
const sha = "a".repeat(40);
const H = "d".repeat(64);
const context = { version: 2, agent: "qa", repo: "owner/repo", taskId: 2, op: 0, issue: null, pr: 12, branch: "kcw/task-2", baseSha: sha, remoteSha: sha, workflowSha: sha, contractHash: H };
const hashFor = (agent: string) => (agent === "developer" || agent === "qa" ? H : null);
const dirs: string[] = [];
const dir = () => { const p=mkdtempSync(path.join(tmpdir(),"kcw-boundary-")); dirs.push(p); return p; };
afterEach(() => { for(const p of dirs.splice(0)) rmSync(p,{recursive:true,force:true}); vi.unstubAllEnvs(); });
const gh = (values: unknown[]) => ({ repo: "owner/repo", token: "synthetic", fetch: vi.fn(async () => Response.json(values.shift())) as unknown as typeof fetch });
describe("report messages",()=>{
  const u=(n:number,model="claude-haiku-5-5")=>({kind:"model" as const,provider:"anthropic" as const,model,input_tokens:n,output_tokens:1});
  const run={run_id:900,run_attempt:2};
  const ctx=(agent:"developer"|"qa"|"docs"|"scraper")=>parseTrustedContext(JSON.stringify({...context,agent,op:agent==="scraper"?null:4,contractHash:hashFor(agent)}));
  const none={work:[],review:[]};
  it("starts with the lifecycle event and ends successfully with usage only (Q14(5)), in one identified message",()=>{
    expect(buildReport(ctx("developer"),run,"start","success",{work:[u(1)],review:[]})).toEqual({task_id:2,agent:"developer",run_id:900,run_attempt:2,job:"start",op:4,event_type:"coding",contract:H});
    expect(buildReport(ctx("qa"),run,"start",undefined,none)).toMatchObject({job:"start",event_type:"qa_reviewing",contract:H});
    expect(buildReport(ctx("qa"),run,"end","success",{work:[u(1)],review:[u(2),u(3,"claude-other")]})).toEqual({task_id:2,agent:"qa",...run,job:"end",op:4,contract:H,usage:[
      {...u(1),call:{job:"work",index:0}},{...u(2),call:{job:"review",index:0}},{...u(3,"claude-other"),call:{job:"review",index:1}}]});
    expect(buildReport(ctx("developer"),run,"end","success",none)).toBeNull();
  });
  it("still reports failed once on any unsuccessful end, with or without usage",()=>{
    for(const result of ["failure","cancelled","skipped",undefined]) {
      expect(buildReport(ctx("docs"),run,"end",result,none)).toEqual({task_id:2,agent:"docs",...run,job:"end",op:4,event_type:"failed"});
      expect(buildReport(ctx("docs"),run,"end",result,none)).not.toHaveProperty("contract");
      expect(buildReport(ctx("scraper"),run,"end",result,{work:[u(1),u(2)],review:[]})).toEqual({task_id:2,agent:"scraper",...run,job:"end",op:null,event_type:"failed",
        usage:[{...u(1),call:{job:"work",index:0}},{...u(2),call:{job:"work",index:1}}]});
    }
  });
  it("takes identity only from trusted context: identical candidate lines stay distinct calls, the model name is not part of it",()=>{
    const r=buildReport(ctx("developer"),run,"end","success",{work:[u(5),u(5)],review:[]})!;
    expect(r.usage!.map((x)=>x.call)).toEqual([{job:"work",index:0},{job:"work",index:1}]);
    expect(parseAgentReport(r)).toEqual(r);
  });
});
describe("trusted authority",()=>{
  it("fails empty code tasks while allowing validated PR retries and docs no-op",()=>{
    for(const agent of ["developer", "scraper"] as const) {
      const c=parseTrustedContext(JSON.stringify({...context,agent,op:agent==="scraper"?null:0,pr:null,contractHash:hashFor(agent)}));
      expect(()=>requireCodeProgress(c,false)).toThrow(/no commits/);
      expect(()=>requireCodeProgress(c,true)).not.toThrow();
      expect(()=>requireCodeProgress({...c,pr:12},false)).not.toThrow();
    }
    expect(()=>requireCodeProgress(parseTrustedContext(JSON.stringify({...context,agent:"docs",contractHash:null})),false)).not.toThrow();
  });
  it("rejects work fields, changed role schema, traversal branch and malformed baseline",()=>{
    expect(parseTrustedContext(JSON.stringify(context))).toEqual(context);
    for(const change of [{ extra:true },{baseSha:"HEAD"},{branch:"kcw/task-3"},{agent:"owner"},{taskId:0},{op:-1},{op:null},{op:1.5},{op:1_000_000_000},{repo:"https://other/repo"},{version:1},{contractHash:null},{contractHash:"D".repeat(64)},{agent:"docs"},{agent:"developer",contractHash:"abc"}])
      expect(()=>parseTrustedContext(JSON.stringify({...context,...change}))).toThrow();
  });
  it("binds op: required for dispatched agents, null only for the scraper",()=>{
    expect(parseTrustedContext(JSON.stringify({...context,agent:"developer",op:7})).op).toBe(7);
    expect(parseTrustedContext(JSON.stringify({...context,agent:"scraper",op:null,contractHash:null})).op).toBeNull();
    expect(()=>parseTrustedContext(JSON.stringify({...context,agent:"scraper",op:0,contractHash:null}))).toThrow();
    const { op: _op, ...without } = context;
    expect(()=>parseTrustedContext(JSON.stringify(without))).toThrow();
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
  it("labels DeepSeek usage as deepseek and drops any other provider",()=>{
    const root=dir(); const deepseek={kind:"model",provider:"deepseek",model:"deepseek-flash",input_tokens:3,output_tokens:4};
    writeFileSync(path.join(root,"usage.json"),JSON.stringify([deepseek])); expect(readAdvisoryUsage(root)).toEqual([deepseek]);
    writeFileSync(path.join(root,"usage.json"),JSON.stringify([{...deepseek,provider:"openai"}])); expect(readAdvisoryUsage(root)).toEqual([]);
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
describe("contract binding at publish",()=>{
  const contract:TaskContract={v:1,task:2,revision:1,issue:5,goal:"Synthetic goal.",acceptance:["Done."],base:sha,prerequisites:[],scope:[],context:[]};
  const text=canonicalContract(contract);
  const hash=createHash("sha256").update(text).digest("hex");
  const ctx=(over:Record<string,unknown>={})=>parseTrustedContext(JSON.stringify({...context,agent:"developer",op:3,contractHash:hash,...over}));
  const file=(content:string)=>{const p=path.join(dir(),"contract.json");writeFileSync(p,content);return p;};
  it("returns the contract when its bytes match the trusted hash",()=>{
    expect(readContract(file(text),ctx())).toEqual(contract);
    expect(readContract("unused",ctx({agent:"docs",contractHash:null}))).toBeNull();
  });
  it("refuses a changed contract file, a task mismatch and an oversized file",()=>{
    expect(()=>readContract(file(text.replace("Synthetic","Changed")),ctx())).toThrow(/^contract_hash_mismatch$/);
    expect(()=>readContract(file(`${text} `),ctx())).toThrow(/^contract_hash_mismatch$/);
    expect(()=>readContract(file("x".repeat(30_000)),ctx())).toThrow(/^contract_hash_mismatch$/);
    expect(()=>readContract(file(text),ctx({taskId:3,branch:"kcw/task-3"}))).toThrow(/^contract_task_mismatch$/);
  });
  it("refuses a live task PR that no longer closes the contract issue, and skips docs or no PR",async()=>{
    const open={body:"Closes #5"};
    await expect(requireContractIssue(gh([open]),ctx({pr:9}),contract)).resolves.toBeUndefined();
    await expect(requireContractIssue(gh([{body:"Closes #6"}]),ctx({pr:9}),contract)).rejects.toThrow(/^contract_issue_mismatch$/);
    await expect(requireContractIssue(gh([{body:"no link"}]),ctx({pr:9}),contract)).rejects.toThrow(/^contract_issue_mismatch$/);
    await expect(requireContractIssue(gh([]),ctx({pr:null}),contract)).resolves.toBeUndefined();
    await expect(requireContractIssue(gh([]),ctx({agent:"docs",contractHash:null,pr:9}),contract)).resolves.toBeUndefined();
  });
});

describe("prepareContext (AR5a)", () => {
  const WF = "c".repeat(40), BASE = "a".repeat(40), MERGE = "b".repeat(40), HEAD = "e".repeat(40);
  const REPO = "owner/repo";
  const contract: TaskContract = { v: 1, task: 12, revision: 1, issue: 5, goal: "Synthetic goal.", acceptance: ["Done."], base: BASE, prerequisites: [{ task: 3, merge: MERGE }], scope: [], context: [] };
  const text = canonicalContract(contract);
  const pull = { number: 9, title: "T", body: "Closes #5", state: "open", merged: false, merge_commit_sha: null, user: { login: "x" },
    head: { ref: "kcw/task-12", sha: HEAD, repo: { full_name: REPO } }, base: { ref: "main" } };
  const check = { name: "ci/required", head_sha: HEAD, app: { slug: "github-actions" }, status: "completed", conclusion: "success" };
  const routes = (run: string, compare = "ahead"): Record<string, unknown> => ({
    [`/repos/${REPO}/issues/5`]: { number: 5, title: "I", body: "raw issue body", state: "open" },
    [`/repos/${REPO}/pulls/9`]: pull,
    [`/repos/${REPO}/commits/${HEAD}/check-runs?filter=latest&per_page=100`]: { total_count: 1, check_runs: [check] },
    [`/repos/${REPO}/compare/${BASE}...${run}?per_page=1`]: { status: compare },
    [`/repos/${REPO}/compare/${MERGE}...${run}?per_page=1`]: { status: compare },
  });
  const client = (r: Record<string, unknown>) => ({ repo: REPO, token: "synthetic",
    fetch: (async (url: string | URL) => { const body = r[String(url).replace("https://api.github.com", "")]; return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body); }) as typeof fetch });
  const files = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
  const dev = { agent: "developer", taskId: 12, issue: 5, mode: "implement" } as const;
  const qa = { agent: "qa", taskId: 12, pr: 9, mode: "implement" } as const;

  it("writes exactly context.json, task.md and contract.json for developer and QA", async () => {
    for (const [inputs, run] of [[dev, WF], [qa, HEAD]] as const) {
      const d = path.join(dir(), "context");
      const r = await prepareContext({ inputs, op: 1, gh: client(routes(run)), contractText: text, workflowSha: WF, dir: d });
      expect(r).toEqual({ baseSha: run, skip: "false" });
      expect(files(d)).toEqual(["context.json", "contract.json", "task.md"]);
      expect(readFileSync(path.join(d, "contract.json"), "utf8")).toBe(text);
      expect(readFileSync(path.join(d, "task.md"), "utf8")).not.toContain("raw issue body");
      const c = parseTrustedContext(readFileSync(path.join(d, "context.json"), "utf8"));
      expect(c.contractHash).toBe(createHash("sha256").update(text).digest("hex"));
    }
  });

  it("writes nothing when the contract or its base is refused", async () => {
    const cases: [string, unknown, string | undefined, Record<string, unknown>][] = [
      ["contract_invalid", dev, undefined, routes(WF)],
      ["contract_task_mismatch", dev, canonicalContract({ ...contract, task: 13 }), routes(WF)],
      ["contract_issue_mismatch", dev, canonicalContract({ ...contract, issue: 6 }), routes(WF)],
      ["contract_issue_mismatch", qa, canonicalContract({ ...contract, issue: 6 }), routes(HEAD)],
      ["contract_base_not_contained", dev, text, routes(WF, "behind")],
      ["contract_prerequisite_not_contained", dev, text, { ...routes(WF), [`/repos/${REPO}/compare/${MERGE}...${WF}?per_page=1`]: { status: "diverged" } }],
    ];
    for (const [code, inputs, contractText, r] of cases) {
      const d = path.join(dir(), "context");
      await expect(prepareContext({ inputs: inputs as typeof dev, op: 1, gh: client(r), contractText, workflowSha: WF, dir: d })).rejects.toThrow(new RegExp(`^${code}$`));
      expect(existsSync(d)).toBe(false);
    }
  });
});

describe("readContract read failures", () => {
  it("throws only the fixed code for a missing file or a directory", () => {
    const c = parseTrustedContext(JSON.stringify({ ...context, agent: "developer", op: 3, contractHash: "f".repeat(64) }));
    const d = dir();
    for (const f of [path.join(d, "missing.json"), d]) {
      const err = (() => { try { readContract(f, c); } catch (e) { return e as Error; } })();
      expect(err?.message).toBe("contract_hash_mismatch");
    }
  });
});
