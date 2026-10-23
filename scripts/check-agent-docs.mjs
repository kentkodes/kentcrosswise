// Dependency-free integrity checks for the canonical instruction/continuity surface.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRYPOINTS = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];
const GUIDE = "docs/agents/INSTRUCTIONS.md";
const RECORD_SECTIONS = [
  "Observation and provenance", "Repository and refs", "PRs and checks", "Ownership and changes",
  "Verification", "Decisions and security holds", "Remaining work and next action",
];

function headings(markdown) {
  return new Set([...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1]
    .toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-")));
}

/** Returns diagnostics without mutating the checkout or requiring installed packages. */
export function checkAgentDocs(root) {
  const errors = [];
  const agentDir = path.join(root, "docs/agents");
  const files = [
    ...ENTRYPOINTS, "apps/web/AGENTS.md", "docs/HANDOFF.md", "docs/DESIGN.md",
    ...(existsSync(agentDir) ? readdirSync(agentDir).filter((f) => f.endsWith(".md")).map((f) => `docs/agents/${f}`) : []),
  ];
  const required = [GUIDE, "docs/agents/CONTINUITY.md", "docs/agents/HANDOFF-TEMPLATE.md"];
  for (const file of required) if (!files.includes(file)) files.push(file);
  const content = new Map();
  for (const file of files) {
    if (!existsSync(path.join(root, file))) { errors.push(`${file}: missing file`); continue; }
    const text = readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
    content.set(file, text);
    if (/[A-Za-z]:[\\/](?:Users|workspace|work)[\\/]|\/(?:Users|home)\/[\w.-]+\/|(?:\.claude|\.Codex)[\\/]agent-memory[\\/]/i.test(text)) {
      errors.push(`${file}: local workspace/profile or agent-memory path`);
    }
    for (const link of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
      const target = link[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const [filePart, fragment] = target.split("#");
      const resolved = path.resolve(path.dirname(path.join(root, file)), decodeURIComponent(filePart || path.basename(file)));
      const relative = path.relative(root, resolved);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
        errors.push(`${file}: link escapes repository (${target})`);
      } else if (!existsSync(resolved)) {
        errors.push(`${file}: broken local link (${target})`);
      } else if (fragment && resolved.endsWith(".md") && !headings(readFileSync(resolved, "utf8")).has(fragment)) {
        errors.push(`${file}: missing local heading (${target})`);
      }
    }
  }
  for (const entry of ENTRYPOINTS) {
    const text = content.get(entry) ?? "";
    const links = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((m) => m[1]);
    if (links.length !== 1 || links[0] !== GUIDE || !/read and follow/.test(text) || text.trim().split(/\s+/).length > 85 || /^## /m.test(text)) {
      errors.push(`${entry}: must remain a thin mandatory pointer to ${GUIDE}`);
    }
  }
  for (const [file, targets] of [
    [GUIDE, ["CONTINUITY.md", "../HANDOFF.md", "../../apps/web/AGENTS.md"]],
    ["docs/agents/CONTINUITY.md", ["HANDOFF-TEMPLATE.md", "../HANDOFF.md", "INSTRUCTIONS.md"]],
  ]) {
    for (const target of targets) if (!(content.get(file) ?? "").includes(`](${target})`)) errors.push(`${file}: missing required pointer (${target})`);
  }
  for (const file of ["docs/HANDOFF.md", "docs/agents/HANDOFF-TEMPLATE.md"]) {
    for (const section of RECORD_SECTIONS) if (!(content.get(file) ?? "").includes(`## ${section}\n`)) errors.push(`${file}: missing section ${section}`);
  }
  const generated = content.get("apps/web/AGENTS.md") ?? "";
  if (!/<!-- BEGIN:nextjs-agent-rules -->[\s\S]+node_modules\/next\/dist\/docs\/[\s\S]+<!-- END:nextjs-agent-rules -->/.test(generated)) {
    errors.push("apps/web/AGENTS.md: missing generated Next.js rules block");
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const errors = checkAgentDocs(root);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Agent documentation integrity checks passed.");
}
