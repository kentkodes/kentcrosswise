// The repository brief (AR5a, DESIGN §4.2 step 2): the `## Layout` section of docs/agents/INSTRUCTIONS.md,
// read at the contract base. It is public repository text that gives the planner the repo's map.

/** The file the brief comes from. */
export const REPO_BRIEF_PATH = "docs/agents/INSTRUCTIONS.md";

/** Upper bound for the brief, in UTF-8 bytes. */
export const MAX_REPO_BRIEF_BYTES = 8_192;

/**
 * The `## Layout` section (heading included, up to the next `## ` heading), trimmed. Null when the
 * section is missing, empty, or larger than MAX_REPO_BRIEF_BYTES (the task then goes to the owner).
 */
export function repoBrief(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === "## Layout");
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end).join("\n").trim();
  if (section === "## Layout") return null;
  return Buffer.byteLength(section, "utf8") > MAX_REPO_BRIEF_BYTES ? null : section;
}
