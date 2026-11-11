"use server";
// Essay actions: setup (types and lengths) and ratings. Owner only; each action checks the owner first.
import { redirect } from "next/navigation";
import { isUuid } from "@/server/console";
import { withDb } from "@/server/db";
import { EssayNotFoundError, parsePrefs, parseRating, savePrefs, saveRating } from "@/server/essay-library";
import { requireOwner } from "@/server/owner";
import { failureNotice, type NoticeCode } from "../notices";

export async function savePrefsAction(formData: FormData): Promise<void> {
  await requireOwner();
  let notice: NoticeCode;
  try {
    const prefs = parsePrefs(formData.getAll("type"), formData.getAll("length"));
    await withDb("web_rw", (db) => savePrefs(db, prefs));
    notice = "prefs-saved";
  } catch (err) {
    notice = failureNotice(err, "essays");
  }
  redirect(`/essays/setup?n=${notice}`);
}

export async function rateAction(formData: FormData): Promise<void> {
  await requireOwner();
  const essayId = String(formData.get("essay_id") ?? "");
  let notice: NoticeCode;
  // A missing essay has no reader to return to, so its notice goes to the feed.
  let target = isUuid(essayId) ? `/essays/${essayId}` : "/essays";
  try {
    const rating = parseRating({
      stars: formData.get("stars"),
      worked: formData.getAll("worked"),
      lengthFelt: formData.get("length_felt"),
    });
    await withDb("web_rw", (db) => saveRating(db, essayId, rating));
    notice = "rated";
  } catch (err) {
    if (err instanceof EssayNotFoundError) {
      notice = "essay-not-found";
      target = "/essays";
    } else {
      notice = failureNotice(err, "essays");
    }
  }
  redirect(`${target}?n=${notice}`);
}
