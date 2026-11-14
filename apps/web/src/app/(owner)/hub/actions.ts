"use server";
// Hub capture action. Checks the owner first: server actions are POST endpoints of their own and are
// not covered by the (owner) layout's check.
import { redirect } from "next/navigation";
import { parseCapture, saveEntry } from "@/server/capture";
import { withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { failureNotice, type NoticeCode } from "../notices";

export async function captureAction(formData: FormData): Promise<void> {
  await requireOwner();
  const parsed = parseCapture(formData.get("raw_text"));
  let notice: NoticeCode;
  if (!parsed.ok) {
    notice = parsed.error === "empty" ? "capture-empty" : "capture-too-long";
  } else {
    try {
      await withDb("web_rw", (db) => saveEntry(db, parsed.text));
      notice = "captured";
    } catch (err) {
      notice = failureNotice(err, "hub");
    }
  }
  redirect(`/hub?n=${notice}`);
}
