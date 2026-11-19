"use server";
// Hub actions. Each checks the owner first: server actions are POST endpoints of their own and are not covered
// by the (owner) layout's check. Each ends in a redirect with a fixed notice code (never the entry text).
import { redirect } from "next/navigation";
import { validTimeZone } from "../../../server/calendar";
// Relative on purpose, like calendar above: the action tests mock the "@/server/*" modules one by one.
import { addOwnerTerm, confirmEntry, isTermKind } from "../../../server/review";
import { isEntryId } from "../../../server/router";
import { isContactId, resolveCrmNote } from "../../../server/contacts";
import { publishNow } from "../../../server/publish";
import { parseCapture, saveEntry } from "@/server/capture";
import { withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { failureNotice, type NoticeCode } from "../notices";
import { capturedNotice, prepareNow, reassignNotice, routeAgainNotice, routeNow } from "../routing";

export async function captureAction(formData: FormData): Promise<void> {
  await requireOwner();
  const parsed = parseCapture(formData.get("raw_text"));
  let notice: NoticeCode;
  if (!parsed.ok) {
    notice = parsed.error === "empty" ? "capture-empty" : "capture-too-long";
  } else {
    try {
      const zone = validTimeZone(formData.get("time_zone"));
      const id = await withDb("web_rw", async (db) => {
        const saved = await saveEntry(db, parsed.text);
        if (zone) await db.query("UPDATE entries SET time_zone = $2 WHERE id = $1", [saved, zone]);
        return saved;
      });
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

/** Review: "Correct" confirms the model's route of an entry awaiting review (entry_id in the form). */
export async function confirmAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("entry_id");
  let notice: NoticeCode = "invalid";
  if (isEntryId(id)) {
    try {
      const res = await withDb("web_rw", (db) => confirmEntry(db, id));
      notice = res === "ok" ? "review-confirmed" : res === "already" ? "review-already" : "entry-not-found";
      // Publication follows the review (PL4); a failure here is logged and never changes the notice.
      if (res === "ok") await publishNow(id);
    } catch (err) {
      notice = failureNotice(err, "hub");
    }
  }
  redirect(`/hub?n=${notice}#review`);
}

/** Review: adds a tapped word of the public text as a person or a place replacement (entry_id, term, kind). */
export async function addTermAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("entry_id");
  const kind = formData.get("kind");
  let notice: NoticeCode = "invalid";
  if (isEntryId(id) && isTermKind(kind)) {
    try {
      const res = await withDb("web_rw", (db) => addOwnerTerm(db, id, formData.get("term"), kind));
      if (res === "ok") await publishNow(id); // a published record gets the new replacement
      notice =
        res === "ok"
          ? "term-added"
          : res === "exists"
            ? "term-exists"
            : res === "full"
              ? "term-full"
              : res === "not-ready"
                ? "term-not-ready"
                : res === "not-found"
                  ? "entry-not-found"
                  : "invalid";
    } catch (err) {
      notice = failureNotice(err, "hub");
    }
  }
  redirect(`/hub?n=${notice}#review`);
}

/**
 * Review: changes the contact of a contact note awaiting review (entry_id, note_id, contact_id or empty for none).
 * After an automatic link this is the owner's "wrong contact" verdict (PL6b); keeping the same contact counts as
 * confirmed. The route still waits for Correct or a reassignment.
 */
export async function changeContactAction(formData: FormData): Promise<void> {
  await requireOwner();
  const entryId = formData.get("entry_id");
  const noteId = formData.get("note_id");
  const raw = formData.get("contact_id");
  const contactId = raw === "" || raw === null ? null : raw;
  let notice: NoticeCode = "invalid";
  if (isEntryId(entryId) && isContactId(noteId) && (contactId === null || isContactId(contactId))) {
    try {
      const res = await withDb("web_rw", (db) => resolveCrmNote(db, noteId, contactId));
      notice = res === "ok" ? (contactId === null ? "contact-cleared" : "contact-changed") : "contact-not-found";
      if (res === "ok") await publishNow(entryId); // a no-op until the entry is reviewed
    } catch (err) {
      notice = failureNotice(err, "hub");
    }
  }
  redirect(`/hub?n=${notice}#review`);
}

/** Review: "Find names again" after a failed, capped or timed-out name check (entry_id in the form). */
export async function findNamesAction(formData: FormData): Promise<void> {
  await requireOwner();
  const id = formData.get("entry_id");
  let notice: NoticeCode = "invalid";
  if (isEntryId(id)) {
    const res = await prepareNow(id);
    await publishNow(id); // a reviewed entry withheld for its name check is published once the check succeeds
    notice =
      res === "ok" || res === "kept"
        ? "names-ready"
        : res === "off"
          ? "route-off"
          : res === "cap"
            ? "names-capped"
            : res === "not-found"
              ? "entry-not-found"
              : "names-failed";
  }
  redirect(`/hub?n=${notice}#review`);
}
