// Planner and public-title nodes on a model provider (DESIGN §4.2 step 2, §4.5, Opus 5.5 at high effort).
//
// Both nodes ask for a JSON object and validate it by hand (the repo has no schema library). An
// answer that fails validation is retried once, telling the model what was wrong; a second failure
// throws PlannerOutputError, which the task graph sends to the owner. A reply that stopped at the token
// limit or was refused is not retried (the same limit or request would fail again): it throws at once.
// Provider errors propagate unchanged (the step fails and SQS redelivers the message).
import type { ModelProvider } from "@kcw/core/models";
import { MAX_ACCEPTANCE_CHARS, MAX_ACCEPTANCE_ITEMS, MAX_PATHS, isContractPath } from "@kcw/core/contract";
import { MAX_TITLE_LENGTH, VIOLATIONS, type Sanitizer, type Violation } from "@kcw/core/sanitize";
import { MAX_SUBTASKS, PlannerInputError, PlannerOutputError, orderSubtasks, type Plan, type PlanRequest, type Planner, type SubtaskList } from "../graph/types";

/** Upper bound for one subtask's text (it is stored as the child's private owner_text). */
export const MAX_SUBTASK_LENGTH = 4000;
/** Upper bound for an issue body. */
export const MAX_BODY_LENGTH = 8000;
/** AR5a: the whole prompt (system, repository brief and task text), in UTF-8 bytes. Larger: a planning failure, no model call. */
export const MAX_PLANNER_INPUT_BYTES = 40_960;

export const PLANNER_SYSTEM = [
  "You plan work for a team of coding agents that maintain a small web app in a public GitHub repository.",
  `Split the owner's task into 1 to ${MAX_SUBTASKS} subtasks. Each subtask becomes one pull request by a developer agent,`,
  "so each must be implementable and reviewable on its own, in the order listed.",
  "The <repository> block is the repository's layout, for reference.",
  "Use a single subtask unless the task clearly contains separate changes.",
  "Write each subtask as a self-contained instruction that keeps every detail of the task it needs.",
  "The subtasks run one after another: each starts only after the previous one is merged, from code that contains it.",
  "Only if a subtask does not need the one before it, write it as an object instead of a string:",
  '{"text": "<subtask>", "after": [<numbers of the subtasks that must be merged first, counting from 1>]}.',
  'Use "after": [] for a subtask that needs no other subtask. Mark independence only when you are sure of it.',
  'Reply with JSON only, no prose and no code fence: {"subtasks": ["<subtask>", ...]}',
].join("\n");

export const PUBLIC_TITLE_SYSTEM = [
  "You write the public GitHub issue for one task of a coding agent. The repository and its issues are public.",
  `title: a product-level summary of the change, at most ${MAX_TITLE_LENGTH} characters.`,
  "body: what to build and how to check it is done, for a developer agent. Markdown is fine.",
  `acceptance: 1 to ${MAX_ACCEPTANCE_ITEMS} checkable statements of at most ${MAX_ACCEPTANCE_CHARS} characters each.`,
  `scope: 0 to ${MAX_PATHS} repository path prefixes the change owns, including the tests that exercise them (unit tests next to the code, end-to-end specs of the pages it changes); context: 0 to ${MAX_PATHS} repository paths to read first.`,
  "Take paths from the <repository> block (the repository's layout); a path has letters, digits, _ . / - only, no .. and no leading /.",
  "A <previous_contract> block, when present, is the earlier version of this issue; it did not lead to an approved change (see <failure>).",
  "Then write a revised version: keep what was right and make the body and the acceptance statements more precise.",
  "Rules for both: plain ASCII only; no names of people; no personal facts; no email addresses, @handles,",
  "URLs or domain names, phone numbers, or numbers longer than 4 digits. Leave out anything private;",
  "describe the change at product level instead.",
  'Reply with JSON only, no prose and no code fence: {"title": "<title>", "body": "<body>", "acceptance": ["<item>"], "scope": ["<path>"], "context": ["<path>"]}',
].join("\n");

export interface ModelPlannerOptions {
  provider: ModelProvider;
  /** Opus 5.5 thinking counts toward the limit; 8000 keeps two planner calls well inside the 5-minute orchestrator Lambda timeout. */
  maxTokens?: number;
}

/**
 * AR5b, replan only: the text of the contract being replaced (public, sanitized) and the fixed
 * failure line, as blocks between <repository> and <task>. Empty for a first plan.
 */
function replanBlocks(req: PlanRequest): string {
  const p = req.previous;
  if (p === undefined) return "";
  const lines = [
    "<previous_contract>",
    `goal: ${p.goal}`,
    `acceptance: ${p.acceptance.join(" | ")}`,
    `scope: ${p.scope.join(", ")}`,
    `context: ${p.context.join(", ")}`,
    "</previous_contract>",
    ...(req.failure === undefined ? [] : ["<failure>", req.failure, "</failure>"]),
  ];
  return `${lines.join("\n")}\n`;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The Planner of the task graph, backed by a model provider. */
export class ModelPlanner implements Planner {
  constructor(private readonly opts: ModelPlannerOptions) {}

  split(req: PlanRequest): Promise<SubtaskList> {
    return this.#ask("planner", PLANNER_SYSTEM, req.brief, req.owner_text, parseSubtasks);
  }

  plan(req: PlanRequest): Promise<Plan> {
    return this.#ask("public_title", PUBLIC_TITLE_SYSTEM, req.brief, req.owner_text, parsePlan, replanBlocks(req));
  }

  async #ask<T>(node: PlannerOutputError["node"], system: string, brief: string, text: string, parse: (raw: string) => Parsed<T>, extra = ""): Promise<T> {
    const prompt = `<repository>\n${brief}\n</repository>\n${extra}<task>\n${text}\n</task>`;
    if (Buffer.byteLength(system, "utf8") + Buffer.byteLength(prompt, "utf8") > MAX_PLANNER_INPUT_BYTES) throw new PlannerInputError();
    const maxTokens = this.opts.maxTokens ?? 8000;
    const first = await this.#reply(node, system, prompt, maxTokens);
    const parsed = parse(first);
    if (parsed.ok) return parsed.value;
    const retry = `${prompt}\n\nYour previous reply was invalid: ${parsed.reason}. Reply again with the JSON object only.`;
    const second = parse(await this.#reply(node, system, retry, maxTokens));
    if (second.ok) return second.value;
    throw new PlannerOutputError(node, second.reason);
  }

  /** The reply text; a reply that stopped early or was refused throws at once, without a retry. */
  async #reply(node: PlannerOutputError["node"], system: string, prompt: string, maxTokens: number): Promise<string> {
    const { text, stop } = await this.opts.provider.complete({ system, prompt, maxTokens });
    if (stop !== "end") throw new PlannerOutputError(node, `reply stopped: ${stop}`);
    return text;
  }
}

// ------------------------------------------------------------------ output schemas

/** The JSON object in a reply; tolerates a code fence or text around it. */
function parseObject(raw: string): Parsed<Record<string, unknown>> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, reason: "no JSON object" };
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "not a JSON object" };
  return { ok: true, value: value as Record<string, unknown> };
}

function text(v: unknown, field: string, max: number): Parsed<string> {
  if (typeof v !== "string") return { ok: false, reason: `${field} is not a string` };
  const t = v.trim();
  if (t.length === 0) return { ok: false, reason: `${field} is empty` };
  if (t.length > max) return { ok: false, reason: `${field} is longer than ${max} characters` };
  return { ok: true, value: t };
}

/**
 * `{"subtasks": [item, ...]}` with 1..MAX_SUBTASKS items, each a non-empty string (it waits for the
 * item before it) or `{"text": string, "after": [n, ...]}` with the 1-based numbers of the subtasks
 * it waits for (AR4). An invalid order (unknown or self reference, cycle) is a schema error.
 */
export function parseSubtasks(raw: string): Parsed<SubtaskList> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const list = obj.value.subtasks;
  if (!Array.isArray(list)) return { ok: false, reason: "subtasks is not an array" };
  if (list.length < 1 || list.length > MAX_SUBTASKS) {
    return { ok: false, reason: `subtasks must have 1 to ${MAX_SUBTASKS} items, not ${list.length}` };
  }
  const out: SubtaskList = [];
  const after: (number[] | undefined)[] = [];
  for (const [i, item] of list.entries()) {
    const isObj = typeof item === "object" && item !== null && !Array.isArray(item);
    const t = text(isObj ? (item as Record<string, unknown>).text : item, isObj ? `subtasks[${i}].text` : `subtasks[${i}]`, MAX_SUBTASK_LENGTH);
    if (!t.ok) return t;
    out.push(t.value);
    if (!isObj) {
      after.push(undefined);
      continue;
    }
    const a = (item as Record<string, unknown>).after;
    if (a === undefined) {
      after.push(undefined);
      continue;
    }
    if (!Array.isArray(a) || !a.every((n) => Number.isInteger(n))) return { ok: false, reason: `subtasks[${i}].after is not a list of subtask numbers` };
    after.push((a as number[]).map((n) => n - 1));
  }
  if (after.some((a) => a !== undefined)) out.after = after;
  const order = orderSubtasks(out);
  if (!order.ok) return order;
  return { ok: true, value: out };
}

function textList(v: unknown, field: string, min: number, max: number, item: (s: string) => string | null): Parsed<string[]> {
  if (!Array.isArray(v)) return { ok: false, reason: `${field} is not an array` };
  if (v.length < min || v.length > max) return { ok: false, reason: `${field} must have ${min} to ${max} items, not ${v.length}` };
  const out: string[] = [];
  for (const [i, e] of v.entries()) {
    if (typeof e !== "string") return { ok: false, reason: `${field}[${i}] is not a string` };
    const t = e.trim();
    const problem = item(t);
    if (problem !== null) return { ok: false, reason: `${field}[${i}] ${problem}` };
    out.push(t);
  }
  return { ok: true, value: out };
}

/**
 * `{"title", "body", "acceptance", "scope", "context"}`: title and body non-empty strings; acceptance
 * 1 to 10 items of 1 to 400 characters; scope and context 0 to 20 repository paths each (the
 * `@kcw/core/contract` path rule). The title's length and content are not schema errors: the
 * sanitizer decides (a failing title becomes `Private task`, §4.5).
 */
export function parsePlan(raw: string): Parsed<Plan> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const title = text(obj.value.title, "title", MAX_BODY_LENGTH);
  if (!title.ok) return title;
  const body = text(obj.value.body, "body", MAX_BODY_LENGTH);
  if (!body.ok) return body;
  const acceptance = textList(obj.value.acceptance, "acceptance", 1, MAX_ACCEPTANCE_ITEMS, (s) =>
    s.length === 0 ? "is empty" : s.length > MAX_ACCEPTANCE_CHARS ? `is longer than ${MAX_ACCEPTANCE_CHARS} characters` : null,
  );
  if (!acceptance.ok) return acceptance;
  const pathItem = (s: string) => (isContractPath(s) ? null : "is not a valid repository path");
  const scope = textList(obj.value.scope, "scope", 0, MAX_PATHS, pathItem);
  if (!scope.ok) return scope;
  const context = textList(obj.value.context, "context", 0, MAX_PATHS, pathItem);
  if (!context.ok) return context;
  // The contract goal is printable ASCII with \n only: normalize line ends and tabs.
  const goal = body.value.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  return { ok: true, value: { title: title.value, body: goal, acceptance: acceptance.value, scope: scope.value, context: context.value } };
}

/**
 * The sanitizer codes of the contract fields other than the goal (AR5a): every acceptance item by
 * `checkText`; every scope and context path by `checkText` with the `url` code ignored (a file
 * name such as `machine.ts` looks like a domain). Codes only, never the text.
 */
export function contractViolations(plan: Plan, sanitizer: Sanitizer): Violation[] {
  const found = new Set<Violation>();
  for (const a of plan.acceptance) for (const v of sanitizer.checkText(a).violations) found.add(v);
  for (const p of [...plan.scope, ...plan.context]) for (const v of sanitizer.checkText(p).violations) if (v !== "url") found.add(v);
  return VIOLATIONS.filter((v) => found.has(v));
}
