"use server";
// Boss console actions. Each one checks the owner first: server actions are POST endpoints of
// their own and are not covered by the (owner) layout's check.
import { redirect } from "next/navigation";
import { createTask, isFlagKey, parseTaskId, queuedTaskExists, setFlag } from "@/server/console";
import { withDb } from "@/server/db";
import { orchestratorQueue, taskCreatedMessage, trySend } from "@/server/orchestrator-queue";
import { requireOwner } from "@/server/owner";
import { failureNotice, type NoticeCode } from "../notices";

export async function createTaskAction(formData: FormData): Promise<void> {
  await requireOwner();
  const ownerText = String(formData.get("owner_text") ?? "");
  // Private by default: the box starts checked, and only an explicit uncheck makes a task public.
  const isPrivate = formData.get("is_private") === "on";
  let notice: NoticeCode;
  let id: number | undefined;
  try {
    id = await withDb("web_rw", (db) => createTask(db, { ownerText, isPrivate }));
    notice = `created-${await trySend(orchestratorQueue(), taskCreatedMessage(id))}`;
  } catch (err) {
    notice = failureNotice(err, "console");
  }
  redirect(`/console?n=${notice}${id === undefined ? "" : `&task=${id}`}`);
}

export async function resendTaskAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = parseTaskId(formData.get("task_id"));
  let notice: NoticeCode = "invalid";
  if (id !== undefined) {
    try {
      const queued = await withDb("web_rw", (db) => queuedTaskExists(db, id), { readOnly: true });
      notice = queued ? `resent-${await trySend(orchestratorQueue(), taskCreatedMessage(id))}` : "resend-skipped";
    } catch (err) {
      notice = failureNotice(err, "console");
    }
  }
  redirect(`/console?n=${notice}`);
}

export async function setFlagAction(formData: FormData): Promise<void> {
  await requireOwner();
  const key = formData.get("key");
  const value = formData.get("value");
  let notice: NoticeCode = "invalid";
  if (isFlagKey(key) && (value === "true" || value === "false")) {
    try {
      await withDb("web_rw", (db) => setFlag(db, key, value === "true"));
      notice = "flag-updated";
    } catch (err) {
      notice = failureNotice(err, "console");
    }
  }
  redirect(`/console?n=${notice}`);
}
