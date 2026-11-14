// Routing helpers shared by the /hub and /inbox actions (H3). They do no auth: each calling action checks the
// owner first. Nothing here throws, so a failed route never loses a saved capture; it becomes a notice code.
import { dbErrorLabel, withDb } from "@/server/db";
import { isEntryId, isRouteKind, reassignEntry, routeEntry, routerDb, routerFromEnv, type RouteOutcome } from "@/server/router";
import { CAPTURED_ROUTED, failureNotice, ROUTED, type NoticeCode } from "./notices";

/** Routes an entry now with the configured model ("off" when routing is not configured here). */
export async function routeNow(entryId: string): Promise<RouteOutcome> {
  try {
    const provider = await routerFromEnv(process.env);
    if (!provider) return { code: "off" };
    return await routeEntry(routerDb, entryId, provider);
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
    const res = await withDb("web_rw", (db) => reassignEntry(db, id, to));
    return res === "ok" ? ROUTED[to] : "entry-not-found";
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
