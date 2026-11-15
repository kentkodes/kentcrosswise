"use server";
// Social actions. Each checks the owner first: server actions are POST endpoints of their own and are not
// covered by the (owner) layout's check. Each ends in a redirect with a fixed notice code (never a handle
// or a number).
import { redirect } from "next/navigation";
import { withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import {
  addAccount,
  deleteAccount,
  newAccountFromForm,
  parseSource,
  snapshotFromForm,
  upsertSnapshot,
} from "@/server/social";
import { noticeFor, type NoticeCode } from "./notices";

function back(notice: NoticeCode, source: string): never {
  redirect(`/social?n=${notice}&source=${parseSource(source)}`);
}

export async function addAccountAction(formData: FormData): Promise<void> {
  await requireOwner();
  const source = String(formData.get("source") ?? "");
  let notice: NoticeCode;
  try {
    const account = newAccountFromForm(formData);
    await withDb("web_rw", (db) => addAccount(db, account));
    notice = "account-added";
  } catch (err) {
    notice = noticeFor(err);
  }
  back(notice, source);
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  await requireOwner();
  const source = String(formData.get("source") ?? "");
  const accountId = formData.get("account_id");
  let notice: NoticeCode;
  try {
    const deleted = await withDb("web_rw", (db) => deleteAccount(db, typeof accountId === "string" ? accountId : ""));
    notice = deleted ? "account-deleted" : "account";
  } catch (err) {
    notice = noticeFor(err);
  }
  back(notice, source);
}

export async function saveSnapshotAction(formData: FormData): Promise<void> {
  await requireOwner();
  const source = String(formData.get("source") ?? "");
  let notice: NoticeCode;
  try {
    const snapshot = snapshotFromForm(formData);
    await withDb("web_rw", (db) => upsertSnapshot(db, snapshot));
    notice = "snapshot-saved";
  } catch (err) {
    notice = noticeFor(err);
  }
  back(notice, source);
}
