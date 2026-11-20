"use server";
// Connect and disconnect for /connections: the owner Google account and the demo calendar (PL7). Each checks the
// owner first (server actions are POST endpoints of their own).
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { GOOGLE_CONNECT_SCOPES } from "@/auth/config";
import { demoConsentSettings, demoGoogle, disconnectGoogle, googleConnection } from "@/server/google";
import { requireOwner } from "@/server/owner";
import { DEMO_CONSENT_COOKIE, DEMO_CONSENT_MAX_AGE_S, demoRedirectUri, siteOrigin, startDemoConsent } from "../../../server/demo-consent";
import { syncDemoCalendar } from "../../../server/demo-calendar";

/** Incremental consent through the Google provider; the callback and its redirect URI do not change. */
export async function connectGoogleAction(): Promise<void> {
  await requireOwner();
  if (!(await googleConnection()).configured) redirect("/connections?n=not-configured");
  await signIn(
    "google",
    { redirectTo: "/connections" },
    { scope: GOOGLE_CONNECT_SCOPES, access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  );
}

export async function disconnectGoogleAction(): Promise<void> {
  await requireOwner();
  const ok = await disconnectGoogle().catch(() => false);
  redirect(`/connections?n=${ok ? "disconnected" : "disconnect-failed"}`);
}

// The demo calendar (PL7): a separate consent for the dummy Google account, never the owner sign-in.

/** Starts the demo consent: a one-use state and PKCE verifier in a short cookie, then Google's account chooser. */
export async function connectDemoCalendarAction(): Promise<void> {
  await requireOwner();
  const settings = (await demoGoogle.connection()).configured ? await demoConsentSettings().catch(() => null) : null;
  if (!settings) redirect("/connections?n=demo-not-configured");
  const origin = siteOrigin(await headers());
  if (!origin) redirect("/connections?n=demo-failed");
  const start = startDemoConsent(settings.clientId, demoRedirectUri(origin));
  (await cookies()).set(DEMO_CONSENT_COOKIE, start.cookie, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax",
    path: "/connections/demo",
    maxAge: DEMO_CONSENT_MAX_AGE_S,
  });
  redirect(start.url);
}

export async function disconnectDemoCalendarAction(): Promise<void> {
  await requireOwner();
  const ok = await demoGoogle.disconnect().catch(() => false);
  redirect(`/connections?n=${ok ? "demo-disconnected" : "demo-disconnect-failed"}#demo-calendar`);
}

/** A full sync of the dummy calendar (after a failure, or a reconnect). */
export async function syncDemoCalendarAction(): Promise<void> {
  await requireOwner();
  const outcome = await syncDemoCalendar(null);
  const code =
    outcome === "synced" || outcome === "nothing"
      ? "demo-synced"
      : outcome === "not-configured"
        ? "demo-not-configured"
        : outcome === "failed"
          ? "demo-sync-failed"
          : "demo-reconnect";
  redirect(`/connections?n=${code}#demo-calendar`);
}
