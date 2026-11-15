"use server";
// Diary actions. Each checks the owner first (server actions are POST endpoints of their own). The entry is saved
// before any scoring, and scoring never fails the save. Each ends in a redirect with a fixed notice code.
import { redirect } from "next/navigation";
import { createDiaryEntry, deleteDiaryEntry, isDiaryId, parseDiaryBody, updateDiaryBody } from "@/server/diary";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { savedNotice, scoreNotice, type DiaryNoticeCode } from "./notices";
import { scoreNow } from "./score";

function failure(err: unknown): DiaryNoticeCode {
  if (err instanceof DbNotConfiguredError) return "db-not-configured";
  console.error(`[diary] ${dbErrorLabel(err)}`);
  return "db-error";
}

export async function saveDiaryAction(formData: FormData): Promise<void> {
  await requireOwner();
  const parsed = parseDiaryBody(formData.get("body"));
  let notice: DiaryNoticeCode;
  if (!parsed.ok) {
    notice = parsed.error;
  } else {
    try {
      const id = await withDb("web_rw", (db) => createDiaryEntry(db, parsed.body));
      notice = savedNotice(await scoreNow(id));
    } catch (err) {
      notice = failure(err);
    }
  }
  redirect(`/diary?n=${notice}`);
}

export async function editDiaryAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("id");
  if (!isDiaryId(id)) redirect("/diary?n=invalid");
  const parsed = parseDiaryBody(formData.get("body"));
  let notice: DiaryNoticeCode;
  if (!parsed.ok) {
    notice = parsed.error;
  } else {
    try {
      const res = await withDb("web_rw", (db) => updateDiaryBody(db, id, parsed.body));
      notice = res === "not-found" ? "not-found" : res === "unchanged" ? "saved" : savedNotice(await scoreNow(id));
    } catch (err) {
      notice = failure(err);
    }
  }
  redirect(notice === "not-found" ? `/diary?n=${notice}` : `/diary/${id}?n=${notice}`);
}

export async function scoreAgainAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("id");
  if (!isDiaryId(id)) redirect("/diary?n=invalid");
  const notice = scoreNotice(await scoreNow(id));
  redirect(notice === "not-found" ? `/diary?n=${notice}` : `/diary/${id}?n=${notice}`);
}

export async function deleteDiaryAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("id");
  if (!isDiaryId(id)) redirect("/diary?n=invalid");
  let notice: DiaryNoticeCode;
  try {
    notice = (await withDb("web_rw", (db) => deleteDiaryEntry(db, id))) ? "deleted" : "not-found";
  } catch (err) {
    notice = failure(err);
  }
  redirect(notice === "db-error" || notice === "db-not-configured" ? `/diary/${id}?n=${notice}` : `/diary?n=${notice}`);
}
