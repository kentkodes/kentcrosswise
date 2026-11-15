"use server";
// Idea actions. Each checks the owner first (a server action is its own POST endpoint). Each ends in a redirect
// with a fixed notice code (never the idea text).
import { redirect } from "next/navigation";
import { withDb } from "@/server/db";
import { addIdea, deleteIdea, setIdeaStatus } from "@/server/lists";
import { requireOwner } from "@/server/owner";
import { ideaFailure, type NoticeCode } from "./notices";

async function run(fn: () => Promise<void>, ok: NoticeCode): Promise<NoticeCode> {
  try {
    await fn();
    return ok;
  } catch (err) {
    return ideaFailure(err);
  }
}

export async function addIdeaAction(formData: FormData): Promise<void> {
  await requireOwner();
  const notice = await run(async () => {
    await withDb("web_rw", (db) => addIdea(db, formData.get("body")));
  }, "idea-added");
  redirect(`/ideas?n=${notice}`);
}

export async function setIdeaStatusAction(formData: FormData): Promise<void> {
  await requireOwner();
  const notice = await run(async () => {
    await withDb("web_rw", (db) => setIdeaStatus(db, formData.get("id"), formData.get("status")));
  }, "idea-status");
  redirect(`/ideas?n=${notice}`);
}

export async function deleteIdeaAction(formData: FormData): Promise<void> {
  await requireOwner();
  const notice = await run(async () => {
    await withDb("web_rw", (db) => deleteIdea(db, formData.get("id")));
  }, "idea-deleted");
  redirect(`/ideas?n=${notice}`);
}
