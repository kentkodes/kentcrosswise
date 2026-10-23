"use server";
// Inbox actions: approve or reject an approval, then resume the task's thread (DESIGN §4.3).
// Each one checks the owner first (server actions are not covered by the layout's check).
import { redirect } from "next/navigation";
import { decideApproval, decidedApproval, isDecision } from "@/server/console";
import { withDb } from "@/server/db";
import { orchestratorQueue, ownerDecisionMessage, trySend } from "@/server/orchestrator-queue";
import { requireOwner } from "@/server/owner";
import { failureNotice, type NoticeCode } from "../notices";

export async function decideAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("approval_id") ?? "");
  const decision = formData.get("decision");
  const note = String(formData.get("note") ?? "");
  let notice: NoticeCode = "invalid";
  if (isDecision(decision)) {
    try {
      const res = await withDb("web_rw", (db) => decideApproval(db, { id, decision, note }));
      if (!res.decided) notice = "already-decided";
      else if (res.taskId === null) notice = "decided-no-task";
      else notice = `decided-${await trySend(orchestratorQueue(), ownerDecisionMessage(res.taskId, id, decision))}`;
    } catch (err) {
      notice = failureNotice(err, "inbox");
    }
  }
  redirect(`/inbox?n=${notice}`);
}

export async function resendDecisionAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = String(formData.get("approval_id") ?? "");
  let notice: NoticeCode;
  try {
    const a = await withDb("web_rw", (db) => decidedApproval(db, id), { readOnly: true });
    notice =
      a === undefined || a.taskId === null
        ? "resend-skipped"
        : `resent-${await trySend(orchestratorQueue(), ownerDecisionMessage(a.taskId, id, a.decision))}`;
  } catch (err) {
    notice = failureNotice(err, "inbox");
  }
  redirect(`/inbox?n=${notice}`);
}
