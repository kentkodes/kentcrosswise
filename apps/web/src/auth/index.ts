// Auth.js v5 for the owner area. Settings are read from Secrets Manager at first use (D9),
// so the config is built lazily per request (cached settings, see @kcw/secrets).
import { defaultSecretStore } from "@kcw/secrets";
import NextAuth from "next-auth";
import type { Session } from "next-auth";
import { isOwnerEmail } from "./allowlist";
import { buildAuthConfig, googleProvider } from "./config";
import { loadPreviewModule } from "./env";
import { loadProdSettings, type AuthSettings } from "./settings";

let settingsPromise: Promise<AuthSettings> | undefined;

/** Auth settings for this build (prod: kcw/prod/web; preview: kcw/ci e2e token). Cached per process. */
export function getAuthSettings(): Promise<AuthSettings> {
  settingsPromise ??= (async () => {
    const preview = await loadPreviewModule();
    return preview
      ? preview.loadPreviewSettings(process.env, defaultSecretStore())
      : loadProdSettings(process.env, defaultSecretStore());
  })();
  settingsPromise.catch(() => {
    settingsPromise = undefined;
  });
  return settingsPromise;
}

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const settings = await getAuthSettings();
  const preview = await loadPreviewModule();
  return preview
    ? buildAuthConfig(settings, [preview.previewLoginProvider(settings)], preview.PREVIEW_PROVIDER_ID)
    : buildAuthConfig(settings, [googleProvider(settings)]);
});

/** True if the session belongs to the allowlisted owner. */
export async function isOwnerSession(session: Session | null): Promise<boolean> {
  const email = session?.user?.email;
  if (!email) return false;
  const { ownerEmail } = await getAuthSettings();
  return isOwnerEmail(email, ownerEmail);
}
