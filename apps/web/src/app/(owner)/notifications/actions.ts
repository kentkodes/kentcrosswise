"use server";
// Server actions for /notifications. Each is its own POST endpoint, so each checks the owner first.
// They return fixed codes (see ./notices), never data.
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { loadVapidKeys } from "@/server/push/keys";
import { sendPush } from "@/server/push/send";
import { deleteSubscription, saveSubscription, sendTestPush } from "@/server/push/subscriptions";
import type { PushNoticeCode } from "./notices";

function failure(err: unknown): PushNoticeCode {
  if (!(err instanceof DbNotConfiguredError)) console.error(`[push] page failed ${dbErrorLabel(err)}`);
  return "db-unavailable";
}

export async function saveSubscriptionAction(subscription: unknown): Promise<PushNoticeCode> {
  await requireOwner();
  try {
    if (!(await loadVapidKeys())) return "not-set-up";
    return (await withDb("web_rw", (db) => saveSubscription(db, subscription))) === "saved" ? "saved" : "invalid";
  } catch (err) {
    return failure(err);
  }
}

export async function removeSubscriptionAction(endpoint: unknown): Promise<PushNoticeCode> {
  await requireOwner();
  try {
    await withDb("web_rw", (db) => deleteSubscription(db, endpoint));
    return "removed";
  } catch (err) {
    return failure(err);
  }
}

export async function sendTestAction(): Promise<PushNoticeCode> {
  await requireOwner();
  try {
    const keys = await loadVapidKeys();
    if (!keys) return "not-set-up";
    const outcome = await withDb("web_rw", (db) => sendTestPush(db, keys, (sub, payload, k) => sendPush(sub, payload, k)));
    return outcome === "sent" ? "test-sent" : outcome === "none" ? "no-subscription" : "test-failed";
  } catch (err) {
    return failure(err);
  }
}
