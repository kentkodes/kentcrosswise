// Routing helpers shared by the /hub and /inbox actions (H3). They do no auth: each calling action checks the
// owner first. Nothing here throws, so a failed route never loses a saved capture; it becomes a notice code.
import { dbErrorLabel, withDb } from "@/server/db";
import { isEntryId, isRouteKind, reassignEntryDerived, routeEntry, routerDb, routerFromEnv, type RouteOutcome } from "@/server/router";
// Relative on purpose: the action tests mock the "@/server/*" modules one by one and do not resolve the alias.
import { suggestFromNote } from "../../server/calendar";
import { prepareSpans, type PrepareResult } from "../../server/review";
import { scoreNow } from "./diary/score";
import { CAPTURED_ROUTED, failureNotice, ROUTED, type NoticeCode } from "./notices";

/** A new diary row is scored after its transaction committed, for at most this long. */
export const SCORE_BOUND_MS = 6000;

/**
 * Scores a diary row the route just created, bounded to SCORE_BOUND_MS. Never throws and never changes a notice:
 * on timeout or any outcome other than success the entry stays "Not scored" (the diary page has "Score again").
 */
export async function scoreCreated(derived: { kind: string; id: string } | null | undefined): Promise<void> {
  if (derived?.kind !== "diary") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scoreNow(derived.id),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SCORE_BOUND_MS);
      }),
    ]);
  } catch {
    // scoreNow does not throw; nothing may fail the capture.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A contact note that the owner's choice created gets its calendar suggestion, as a model-routed one does in
 * routeEntry. Never throws and never changes a notice; without a configured model nothing happens.
 */
export async function suggestCreated(derived: { kind: string; id: string } | null | undefined): Promise<void> {
  if (derived?.kind !== "crm_note") return;
  try {
    const provider = await routerFromEnv(process.env);
    if (provider) await suggestFromNote(routerDb, derived.id, provider);
  } catch {
    // suggestFromNote does not throw; nothing may fail the reassignment.
  }
}

/**
 * Finds the names and places in an entry for its public text (PL3), unless a valid proposal is stored. Bounded by
 * proposeSpans; never throws and never changes a notice. "off" when no model is configured here.
 */
export async function prepareNow(entryId: string): Promise<PrepareResult | "off"> {
  try {
    const provider = await routerFromEnv(process.env);
    if (!provider) return "off";
    return await prepareSpans(routerDb, entryId, provider);
  } catch (err) {
    console.error(`[review] ${dbErrorLabel(err)}`);
    return "failed";
  }
}

/** Routes an entry now with the configured model ("off" when routing is not configured here). */
export async function routeNow(entryId: string): Promise<RouteOutcome> {
  try {
    const provider = await routerFromEnv(process.env);
    if (!provider) return { code: "off" };
    const outcome = await routeEntry(routerDb, entryId, provider);
    // Mood scoring and the name check run side by side after the route committed; neither changes the notice.
    if (outcome.code === "routed") await Promise.all([scoreCreated(outcome.derived), prepareNow(entryId)]);
    else if (outcome.code === "needs_owner") await prepareNow(entryId);
    return outcome;
  } catch (err) {
    console.error(`[router] ${dbErrorLabel(err)}`);
    return { code: "error" };
  }
}

/** The notice after a capture: "Saved" plus what the router did. */
export function capturedNotice(o: RouteOutcome): NoticeCode {
  switch (o.code) {
    case "routed":
      return CAPTURED_ROUTED[o.kind];
    case "needs_owner":
      return "captured-needs-owner";
    case "cap":
      return "captured-route-capped";
    case "error":
      return "captured-route-failed";
    default:
      return "captured";
  }
}

/** The notice after "Route again". */
export function routeNotice(o: RouteOutcome): NoticeCode {
  switch (o.code) {
    case "routed":
      return ROUTED[o.kind];
    case "needs_owner":
      return "routed-needs-owner";
    case "already":
      return "route-already";
    case "cap":
      return "route-capped";
    case "off":
      return "route-off";
    case "error":
      return "route-failed";
  }
}

/** Moves the entry in a form (entry_id, to) to a kind and returns the notice. */
export async function reassignNotice(formData: FormData): Promise<NoticeCode> {
  const id = formData.get("entry_id");
  const to = formData.get("to");
  if (!isEntryId(id) || !isRouteKind(to)) return "invalid";
  try {
    const res = await withDb("web_rw", (db) => reassignEntryDerived(db, id, to));
    if (res.result !== "ok") return "entry-not-found";
    await Promise.all([scoreCreated(res.derived), suggestCreated(res.derived), prepareNow(id)]);
    return ROUTED[to];
  } catch (err) {
    return failureNotice(err, "routing");
  }
}

/** "Route again" for a pending entry (entry_id in the form). */
export async function routeAgainNotice(formData: FormData): Promise<NoticeCode> {
  const id = formData.get("entry_id");
  if (!isEntryId(id)) return "invalid";
  return routeNotice(await routeNow(id));
}
