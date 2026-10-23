// Planner and public-title nodes on a model provider (DESIGN §4.2 step 2, §4.5, Q3: Haiku 5.5).
//
// Both nodes ask for a JSON object and validate it by hand (the repo has no schema library). An
// answer that fails validation is retried once, telling the model what was wrong; a second failure
// throws PlannerOutputError, which the task graph sends to the owner. Provider errors propagate
// unchanged (the step fails and SQS redelivers the message).
import type { ModelProvider } from "@kcw/core/models";
import { MAX_TITLE_LENGTH } from "@kcw/core/sanitize";
import { MAX_SUBTASKS, PlannerOutputError, type Plan, type PlanRequest, type Planner } from "../graph/types";

/** Upper bound for one subtask's text (it is stored as the child's private owner_text). */
export const MAX_SUBTASK_LENGTH = 4000;
/** Upper bound for an issue body. */
export const MAX_BODY_LENGTH = 8000;

export const PLANNER_SYSTEM = [
  "You plan work for a team of coding agents that maintain a small web app in a public GitHub repository.",
  `Split the owner's task into 1 to ${MAX_SUBTASKS} subtasks. Each subtask becomes one pull request by a developer agent,`,
  "so each must be implementable and reviewable on its own, in the order listed.",
  "Use a single subtask unless the task clearly contains separate changes.",
  "Write each subtask as a self-contained instruction that keeps every detail of the task it needs.",
  'Reply with JSON only, no prose and no code fence: {"subtasks": ["<subtask>", ...]}',
].join("\n");

export const PUBLIC_TITLE_SYSTEM = [
  "You write the public GitHub issue for one task of a coding agent. The repository and its issues are public.",
  `title: a product-level summary of the change, at most ${MAX_TITLE_LENGTH} characters.`,
  "body: what to build and how to check it is done, for a developer agent. Markdown is fine.",
  "Rules for both: plain ASCII only; no names of people; no personal facts; no email addresses, @handles,",
  "URLs or domain names, phone numbers, or numbers longer than 4 digits. Leave out anything private;",
  "describe the change at product level instead.",
  'Reply with JSON only, no prose and no code fence: {"title": "<title>", "body": "<body>"}',
].join("\n");

export interface ModelPlannerOptions {
  provider: ModelProvider;
  maxTokens?: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The Planner of the task graph, backed by a model provider. */
export class ModelPlanner implements Planner {
  constructor(private readonly opts: ModelPlannerOptions) {}

  split(req: PlanRequest): Promise<string[]> {
    return this.#ask("planner", PLANNER_SYSTEM, req.owner_text, parseSubtasks);
  }

  plan(req: PlanRequest): Promise<Plan> {
    return this.#ask("public_title", PUBLIC_TITLE_SYSTEM, req.owner_text, parsePlan);
  }

  async #ask<T>(node: PlannerOutputError["node"], system: string, text: string, parse: (raw: string) => Parsed<T>): Promise<T> {
    const prompt = `<task>\n${text}\n</task>`;
    const maxTokens = this.opts.maxTokens ?? 1024;
    const first = parse((await this.opts.provider.complete({ system, prompt, maxTokens })).text);
    if (first.ok) return first.value;
    const retry = `${prompt}\n\nYour previous reply was invalid: ${first.reason}. Reply again with the JSON object only.`;
    const second = parse((await this.opts.provider.complete({ system, prompt: retry, maxTokens })).text);
    if (second.ok) return second.value;
    throw new PlannerOutputError(node, second.reason);
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

/** `{"subtasks": [string, ...]}` with 1..MAX_SUBTASKS non-empty strings. */
export function parseSubtasks(raw: string): Parsed<string[]> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const list = obj.value.subtasks;
  if (!Array.isArray(list)) return { ok: false, reason: "subtasks is not an array" };
  if (list.length < 1 || list.length > MAX_SUBTASKS) {
    return { ok: false, reason: `subtasks must have 1 to ${MAX_SUBTASKS} items, not ${list.length}` };
  }
  const out: string[] = [];
  for (const [i, item] of list.entries()) {
    const t = text(item, `subtasks[${i}]`, MAX_SUBTASK_LENGTH);
    if (!t.ok) return t;
    out.push(t.value);
  }
  return { ok: true, value: out };
}

/**
 * `{"title": string, "body": string}`, both non-empty. The title's length and content are not
 * schema errors: the sanitizer decides (a failing title becomes `Private task`, §4.5).
 */
export function parsePlan(raw: string): Parsed<Plan> {
  const obj = parseObject(raw);
  if (!obj.ok) return obj;
  const title = text(obj.value.title, "title", MAX_BODY_LENGTH);
  if (!title.ok) return title;
  const body = text(obj.value.body, "body", MAX_BODY_LENGTH);
  if (!body.ok) return body;
  return { ok: true, value: { title: title.value, body: body.value } };
}
