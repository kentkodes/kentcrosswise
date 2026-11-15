"use server";
// Connect and disconnect for /connections. Each checks the owner first (server actions are POST endpoints of their own).
import { redirect } from "next/navigation";
import { signIn } from "@/auth";
import { GOOGLE_CONNECT_SCOPES } from "@/auth/config";
import { disconnectGoogle, googleConnection } from "@/server/google";
import { requireOwner } from "@/server/owner";

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
