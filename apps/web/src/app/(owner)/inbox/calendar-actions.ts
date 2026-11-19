"use server";
// Calendar region actions. Each checks the owner first (server actions are POST endpoints of their own).
// They end in a redirect carrying a fixed notice code (?cn=), never suggestion text.
import { redirect } from "next/navigation";
import { addSuggestionToCalendar, dismissSuggestion, isSuggestionId } from "@/server/calendar";
import { dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { routerDb } from "@/server/router";
import type { CalendarNoticeCode } from "./calendar-notices";
// Relative on purpose: the action tests mock the "@/server/*" modules one by one and do not resolve the alias.
import { entryOf, publishNow } from "../../../server/publish";

export async function addSuggestionAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("suggestion_id");
  let code: CalendarNoticeCode = "invalid";
  if (isSuggestionId(id)) {
    try {
      code = await addSuggestionToCalendar(routerDb, id);
      if (code === "added") await publishNow(await entryOf("suggestion", id));
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
      if (code === "dismissed") await publishNow(await entryOf("suggestion", id));
    } catch (err) {
      console.error(`[calendar] ${dbErrorLabel(err)}`);
      code = "db-error";
    }
  }
  redirect(`/inbox?cn=${code}`);
}
