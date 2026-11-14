"use server";
// Hub actions. Each checks the owner first: server actions are POST endpoints of their own and are not covered
// by the (owner) layout's check. Each ends in a redirect with a fixed notice code (never the entry text).
import { redirect } from "next/navigation";
import { parseCapture, saveEntry } from "@/server/capture";
import { withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { failureNotice, type NoticeCode } from "../notices";
import { capturedNotice, reassignNotice, routeAgainNotice, routeNow } from "../routing";

export async function captureAction(formData: FormData): Promise<void> {
  await requireOwner();
  const parsed = parseCapture(formData.get("raw_text"));
  let notice: NoticeCode;
  if (!parsed.ok) {
    notice = parsed.error === "empty" ? "capture-empty" : "capture-too-long";
  } else {
    try {
      const id = await withDb("web_rw", (db) => saveEntry(db, parsed.text));
      // Saved first; routing never fails the capture (routeNow does not throw).
      notice = capturedNotice(await routeNow(id));
    } catch (err) {
      notice = failureNotice(err, "hub");
    }
  }
  redirect(`/hub?n=${notice}`);
}

export async function reassignAction(formData: FormData): Promise<void> {
  await requireOwner();
  redirect(`/hub?n=${await reassignNotice(formData)}`);
}

export async function routeAgainAction(formData: FormData): Promise<void> {
  await requireOwner();
  redirect(`/hub?n=${await routeAgainNotice(formData)}`);
}
