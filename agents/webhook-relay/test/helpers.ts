import type { SendMessageCommand } from "@aws-sdk/client-sqs";
import { readFileSync } from "node:fs";
import type { ActionsMinutes, GitHubEventMessage, OrchestratorQueue, RelayStore, SqsLike } from "../src/index";

const FIXTURES = new URL("./fixtures/", import.meta.url);

export type Fixture =
  | "issues.closed"
  | "pull_request.opened"
  | "pull_request_review.submitted"
  | "push"
  | "workflow_run.completed";

// Fixtures are edited freely in tests (deep property writes), so they are typed loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Payload = Record<string, any>;

/** A fresh (mutable) copy of a synthetic webhook payload. */
export function fixture(name: Fixture): Payload {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"));
}

/** Synthetic ids used by the fixtures. */
export const IDS = {
  owner: 9000000,
  orchestrator: 9000001,
  developer: 9000002,
  qa: 9000003,
  stranger: 9999999,
  repo: 1000,
} as const;

export const ALLOWED = new Set<number>([IDS.owner, IDS.orchestrator, IDS.developer, IDS.qa]);
export const SECRET = "synthetic-test-secret";
export const DELIVERY = "5f1a0c2e-0000-4000-8000-000000000001";

/** In-memory RelayStore: tasks by PR/issue number and the claimed delivery ids. */
export class FakeStore implements RelayStore {
  readonly claimed = new Set<string>();
  readonly calls: string[] = [];
  failWith: Error | undefined;
  constructor(
    readonly byPr: Map<number, number> = new Map(),
    readonly byIssue: Map<number, number> = new Map(),
  ) {}
  #call(name: string) {
    this.calls.push(name);
    if (this.failWith) throw this.failWith;
  }
  async claimDelivery(id: string) {
    this.#call("claim");
    if (this.claimed.has(id)) return false;
    this.claimed.add(id);
    return true;
  }
  async releaseDelivery(id: string) {
    this.#call("release");
    this.claimed.delete(id);
  }
  async findTaskByPr(n: number) {
    this.#call("byPr");
    return this.byPr.get(n) ?? null;
  }
  async findTaskByIssue(n: number) {
    this.#call("byIssue");
    return this.byIssue.get(n) ?? null;
  }
  /** Recorded Actions minutes by dedupe key. */
  readonly minutes = new Map<string, { usage: ActionsMinutes; taskId: number | null }>();
  async recordActionsMinutes(usage: ActionsMinutes, taskId: number | null) {
    this.#call("minutes");
    if (this.minutes.has(usage.dedupeKey)) return false;
    this.minutes.set(usage.dedupeKey, { usage, taskId });
    return true;
  }
}

export class FakeQueue implements OrchestratorQueue {
  readonly sent: GitHubEventMessage[] = [];
  failWith: Error | undefined;
  async send(m: GitHubEventMessage) {
    if (this.failWith) throw this.failWith;
    this.sent.push(m);
  }
}

/** Records SendMessage inputs, like the kcw-report tests. */
export class FakeSqs implements SqsLike {
  readonly sent: SendMessageCommand["input"][] = [];
  failWith: Error | undefined;
  async send(command: SendMessageCommand): Promise<unknown> {
    if (this.failWith) throw this.failWith;
    this.sent.push(command.input);
    return { MessageId: `m-${this.sent.length}` };
  }
}

export function awsError(name: string): Error {
  const e = new Error(`${name}: synthetic`);
  e.name = name;
  return e;
}
