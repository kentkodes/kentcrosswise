"use server";
// Calendar region actions. Each checks the owner first (server actions are POST endpoints of their own).
// They end in a redirect carrying a fixed notice code (?cn=), never suggestion text.
import { redirect } from "next/navigation";
import { addSuggestionToCalendar, dismissSuggestion, isSuggestionId } from "@/server/calendar";
import { dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { routerDb } from "@/server/router";
import type { CalendarNoticeCode } from "./calendar-notices";

export async function addSuggestionAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("suggestion_id");
  let code: CalendarNoticeCode = "invalid";
  if (isSuggestionId(id)) {
    try {
      code = await addSuggestionToCalendar(routerDb, id);
    } catch (err) {
      console.error(`[calendar] ${dbErrorLabel(err)}`);
      code = "db-error";
    }
  }
  redirect(`/inbox?cn=${code}`);
}

export async function dismissSuggestionAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("suggestion_id");
  let code: CalendarNoticeCode = "invalid";
  if (isSuggestionId(id)) {
    try {
      code = (await withDb("web_rw", (db) => dismissSuggestion(db, id))) ? "dismissed" : "already";
    } catch (err) {
      console.error(`[calendar] ${dbErrorLabel(err)}`);
      code = "db-error";
    }
  }
  redirect(`/inbox?cn=${code}`);
}
