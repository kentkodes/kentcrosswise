// The demo calendar consent's callback (PL7), apart from the route so tests can drive it. The route checks the owner
// first; this checks the state against the cookie set by the Connect button, exchanges the code (demo-consent.ts),
// stores the calendar id and runs a full sync. Returns the /connections notice code; never throws.
import { timingSafeEqual } from "node:crypto";
import { GOOGLE_DEMO_TOKEN_SECRET_ENV } from "../../../auth/google-consent";
import { withDb } from "../../../server/db";
import { finishDemoConsent, readConsentCookie, type FinishDeps } from "../../../server/demo-consent";
import { saveDemoCalendarId, syncDemoCalendar } from "../../../server/demo-calendar";
import { demoConsentSettings, demoGoogle } from "../../../server/google";
import type { ConnectionNoticeCode } from "./notices";

export interface CallbackDeps extends FinishDeps {
  settings?: () => Promise<{ clientId: string; clientSecret: string; ownerEmail: string } | null>;
  save?: (calendarId: string) => Promise<void>;
  sync?: () => Promise<unknown>;
}

const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function handleDemoCallback(
  params: URLSearchParams,
  cookie: string | undefined,
  redirectUri: string,
  deps: CallbackDeps = {},
): Promise<ConnectionNoticeCode> {
  try {
    const saved = readConsentCookie(cookie);
    const state = params.get("state") ?? "";
    if (!saved || !sameText(saved.state, state)) return "demo-bad-state";
    if (params.get("error")) return "demo-denied";
    const code = params.get("code");
    if (!code || code.length > 2048) return "demo-failed";
    const settings = await (deps.settings ?? demoConsentSettings)();
    if (!settings || (!process.env[GOOGLE_DEMO_TOKEN_SECRET_ENV] && !deps.patch)) return "demo-not-configured";
    const res = await finishDemoConsent({ code, verifier: saved.verifier, redirectUri }, settings, deps);
    if (res.outcome !== "connected" || !res.calendarId) return `demo-${res.outcome}` as ConnectionNoticeCode;
    demoGoogle.resetCache();
    const calendarId = res.calendarId;
    await (deps.save ?? ((id: string) => withDb("web_rw", (db) => saveDemoCalendarId(db, id))))(calendarId);
    await (deps.sync ?? (() => syncDemoCalendar(null)))();
    return "demo-connected";
  } catch (err) {
    console.error(`[demo-consent] callback ${err instanceof Error ? err.name : "Error"}`);
    return "demo-failed";
  }
}
