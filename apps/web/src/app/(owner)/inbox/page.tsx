// Inbox (P2-14): approvals waiting on the owner (critical PRs, agent requests, ...). A decision
// resumes the task's orchestrator thread. Owner only (the (owner) layout; actions check again).
import type { Metadata } from "next";
import Link from "next/link";
import { listApprovals, type ApprovalRow } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { orchestratorQueue } from "@/server/orchestrator-queue";
import { noticeText } from "../notices";
import { decideAction, resendDecisionAction } from "./actions";

export const metadata: Metadata = { title: "Inbox | Kentcrosswise" };

async function load(): Promise<{ data?: { pending: ApprovalRow[]; decided: ApprovalRow[] }; problem?: string }> {
  try {
    return { data: await withDb("web_rw", (db) => listApprovals(db), { readOnly: true }) };
  } catch (err) {
    if (err instanceof DbNotConfiguredError) return { problem: "The database is not connected yet." };
    console.error(`[inbox] ${dbErrorLabel(err)}`);
    return { problem: "The database is unavailable right now." };
  }
}

function Summary({ a }: { a: ApprovalRow }) {
  return (
    <>
      <p>
        <strong>{a.kind.replaceAll("_", " ")}</strong>
        {a.taskId !== null ? <> · task #{a.taskId}</> : null}
        {a.prNumber ? <> · PR #{a.prNumber}</> : null}
      </p>
      {a.taskText ? <p>{a.taskText}</p> : null}
      {a.reasons.length > 0 ? (
        <ul>
          {a.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const notice = noticeText((await searchParams).n);
  const { data, problem } = await load();
  const queue = orchestratorQueue();

  return (
    <main>
      <h1>Inbox</h1>
      <p>
        <Link href="/console">Boss console</Link> · <Link href="/hub">Hub</Link>
      </p>
      {notice ? <p role="status">{notice}</p> : null}
      {problem ? <p role="alert">{problem}</p> : null}
      {data ? (
        <>
          <section aria-labelledby="pending">
            <h2 id="pending">Waiting on you ({data.pending.length})</h2>
            {data.pending.length === 0 ? <p>Nothing is waiting on you.</p> : null}
            <ul data-testid="pending">
              {data.pending.map((a) => (
                <li key={a.id} data-approval-id={a.id}>
                  <Summary a={a} />
                  <form action={decideAction}>
                    <input type="hidden" name="approval_id" value={a.id} />
                    <label>
                      Note <input type="text" name="note" maxLength={1000} />
                    </label>{" "}
                    <button type="submit" name="decision" value="approved">
                      Approve
                    </button>{" "}
                    <button type="submit" name="decision" value="rejected">
                      Reject
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="decided">
            <h2 id="decided">Decided</h2>
            {data.decided.length === 0 ? <p>No decisions yet.</p> : null}
            <ul data-testid="decided">
              {data.decided.map((a) => (
                <li key={a.id} data-approval-id={a.id}>
                  <Summary a={a} />
                  <p>
                    <span data-field="status">{a.status}</span>
                    {a.decidedAt ? <> on {a.decidedAt.replace("T", " ").slice(0, 16)}</> : null}
                    {a.note ? <> · note: {a.note}</> : null}
                  </p>
                  {queue.enabled && a.taskId !== null ? (
                    <form action={resendDecisionAction}>
                      <input type="hidden" name="approval_id" value={a.id} />
                      <button type="submit">Resend decision</button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </main>
  );
}
