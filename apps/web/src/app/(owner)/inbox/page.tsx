// Inbox (P2-14): approvals waiting on the owner (critical PRs, agent requests, ...). A decision
// resumes the task's orchestrator thread. Owner only (the (owner) layout; actions check again).
import type { Metadata } from "next";
import { listApprovals, type ApprovalRow } from "@/server/console";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { orchestratorQueue } from "@/server/orchestrator-queue";
import { requireOwner } from "@/server/owner";
import { formatUtc } from "../format";
import { OwnerFrame } from "../owner-frame";
import { Dot, Notice, Region } from "../owner-ui";
import s from "../owner.module.css";
import { noticeText } from "../notices";
import { approvalTone } from "../tones";
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
      <p className={s.statusLine}>
        <span className={s.emph}>{a.kind.replaceAll("_", " ")}</span>
        {a.taskId !== null ? <span className={s.muted}>· task #{a.taskId}</span> : null}
        {a.prNumber ? <span className={s.muted}>· PR #{a.prNumber}</span> : null}
      </p>
      {a.taskText ? <p className={s.taskText}>{a.taskText}</p> : null}
      {a.reasons.length > 0 ? (
        <ul className={s.reasons}>
          {a.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const notice = noticeText((await searchParams).n);
  const { data, problem } = await load();
  const queue = orchestratorQueue();

  return (
    <OwnerFrame title="Inbox" current="/inbox">
      {notice ? <Notice role="status" tone="ok">{notice}</Notice> : null}
      {problem ? (
        <Notice role="alert" tone="warn">
          {problem}
        </Notice>
      ) : null}
      {data ? (
        <>
          <Region id="pending" title={`Waiting on you (${data.pending.length})`}>
            {data.pending.length === 0 ? <p className={`${s.note} ${s.pad}`}>Nothing is waiting on you.</p> : null}
            <ul data-testid="pending" className={s.list}>
              {data.pending.map((a) => (
                <li key={a.id} data-approval-id={a.id}>
                  <Summary a={a} />
                  <form action={decideAction} className={s.formRow}>
                    <input type="hidden" name="approval_id" value={a.id} />
                    <label className={s.fieldLabel}>
                      Note <input className={s.field} type="text" name="note" maxLength={1000} />
                    </label>
                    <button className={s.button} type="submit" name="decision" value="approved">
                      Approve
                    </button>
                    <button className={s.button} type="submit" name="decision" value="rejected">
                      Reject
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </Region>
          <Region id="decided" title="Decided">
            {data.decided.length === 0 ? <p className={`${s.note} ${s.pad}`}>No decisions yet.</p> : null}
            <ul data-testid="decided" className={s.list}>
              {data.decided.map((a) => (
                <li key={a.id} data-approval-id={a.id}>
                  <Summary a={a} />
                  <p className={s.statusLine}>
                    <Dot tone={approvalTone(a.status)} />
                    <span data-field="status" className={s.emph}>
                      {a.status}
                    </span>
                    {a.decidedAt ? (
                      <>
                        {" "}
                        <time className={s.mono} dateTime={a.decidedAt}>
                          {formatUtc(a.decidedAt)}
                        </time>
                      </>
                    ) : null}
                    {a.note ? <> <span>· note: {a.note}</span></> : null}
                  </p>
                  {queue.enabled && a.taskId !== null ? (
                    <form action={resendDecisionAction} className={s.end}>
                      <input type="hidden" name="approval_id" value={a.id} />
                      <button className={s.button} type="submit">
                        Resend decision
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </Region>
        </>
      ) : null}
    </OwnerFrame>
  );
}
