// The task contract (AR5a): the versioned, bounded, hash-identified description of one task revision
// that every Developer and QA run receives as the `contract` dispatch input. It is built only from
// sanitized public text and is public. Errors carry a fixed code and never echo the input.
import { createHash } from "node:crypto";

export const CONTRACT_VERSION = 1;
export const MAX_CONTRACT_BYTES = 24_576;
export const MAX_GOAL_CHARS = 8000;
export const MAX_ACCEPTANCE_ITEMS = 10;
export const MAX_ACCEPTANCE_CHARS = 400;
export const MAX_PREREQUISITES = 4;
export const MAX_PATHS = 20;

export interface ContractPrerequisite {
  task: number;
  /** The prerequisite's merge commit (40-hex). */
  merge: string;
}

export interface TaskContract {
  v: 1;
  task: number;
  revision: number;
  issue: number;
  goal: string;
  acceptance: string[];
  /** The main head at planning (contains every prerequisite merge). 40-hex. */
  base: string;
  prerequisites: ContractPrerequisite[];
  /**
   * Repo path prefixes the task owns (guidance, not enforced). The tests that exercise them are in scope
   * too, listed or not (AR9a: QA and the Developer may update their selectors, fixtures and expectations).
   */
  scope: string[];
  /** Repo paths to read first (loaded on demand). */
  context: string[];
}

export class ContractError extends Error {
  override name = "ContractError";
  constructor(readonly code: "contract_invalid") {
    super(code);
  }
}

const invalid = (): never => {
  throw new ContractError("contract_invalid");
};

const SHA = /^[a-f0-9]{40}$/;
const PATH = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/;
const KEYS = "acceptance,base,context,goal,issue,prerequisites,revision,scope,task,v";

/** A repository path entry: no `..` segment, no leading `/`, no `//`, no scheme. */
export function isContractPath(s: unknown): s is string {
  return typeof s === "string" && PATH.test(s) && !s.includes("//") && !s.split("/").includes("..");
}

const isId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
const printable = (s: string, newline: boolean): boolean => (newline ? /^[\x20-\x7E\n]+$/ : /^[\x20-\x7E]+$/).test(s);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** Keys sorted recursively, no whitespace, arrays in order. */
export function canonicalContract(c: TaskContract): string {
  return JSON.stringify(sortKeys(c));
}

/** SHA-256 hex of the canonical UTF-8 bytes. */
export function contractHash(c: TaskContract): string {
  return createHash("sha256").update(canonicalContract(c), "utf8").digest("hex");
}

function paths(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_PATHS || !v.every(isContractPath)) return invalid();
  return v as string[];
}

/** Strict parse: exact keys, bounds, and the text must be its own canonical form. */
export function parseContract(text: unknown): TaskContract {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_CONTRACT_BYTES) return invalid();
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!isObject(x) || Object.keys(x).sort().join(",") !== KEYS || x.v !== CONTRACT_VERSION) return invalid();
  const { task, revision, issue, goal, acceptance, base, prerequisites } = x;
  if (!isId(task) || !isId(revision) || !isId(issue)) return invalid();
  if (typeof goal !== "string" || goal.length < 1 || goal.length > MAX_GOAL_CHARS || !printable(goal, true)) return invalid();
  if (!Array.isArray(acceptance) || acceptance.length < 1 || acceptance.length > MAX_ACCEPTANCE_ITEMS ||
      !acceptance.every((a) => typeof a === "string" && a.length >= 1 && a.length <= MAX_ACCEPTANCE_CHARS && printable(a, false))) return invalid();
  if (typeof base !== "string" || !SHA.test(base)) return invalid();
  if (!Array.isArray(prerequisites) || prerequisites.length > MAX_PREREQUISITES ||
      !prerequisites.every((p) => isObject(p) && Object.keys(p).sort().join(",") === "merge,task" && isId(p.task) && typeof p.merge === "string" && SHA.test(p.merge))) return invalid();
  const contract: TaskContract = {
    v: 1, task, revision, issue, goal, acceptance: acceptance as string[], base,
    prerequisites: (prerequisites as ContractPrerequisite[]).map((p) => ({ task: p.task, merge: p.merge })),
    scope: paths(x.scope), context: paths(x.context),
  };
  if (canonicalContract(contract) !== text) return invalid();
  return contract;
}
