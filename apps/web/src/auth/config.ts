import type { NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import { isAllowedSignIn } from "./allowlist";
import type { AuthSettings } from "./settings";

/** Sign-in scopes only. Calendar/YouTube come later by incremental consent (P1-07, Phase 3). */
export const GOOGLE_SIGN_IN_SCOPES = "openid email profile";

export function googleProvider(settings: AuthSettings): Provider {
  if (!settings.google) throw new Error("Google client settings are missing");
  return Google({
    clientId: settings.google.clientId,
    clientSecret: settings.google.clientSecret,
    authorization: { params: { scope: GOOGLE_SIGN_IN_SCOPES } },
  });
}

/** The Auth.js error type (e.g. CredentialsSignin); minified class names are useless in prod logs. */
export function authErrorType(error: Error): string {
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" ? type : "Error";
}

/**
 * Builds the Auth.js config. Providers are passed in so prod (Google) and preview
 * (credentials) builds differ only in what ./index decides to load.
 */
export function buildAuthConfig(
  settings: AuthSettings,
  providers: Provider[],
  previewProviderId?: string,
): NextAuthConfig {
  return {
    secret: settings.authSecret,
    // CloudFront forwards the viewer host in x-forwarded-host (infra/modules/web viewer function).
    trustHost: true,
    session: { strategy: "jwt" },
    providers,
    // One line per auth error, type only: no stacks or messages that could carry tokens or emails.
    logger: {
      error(error) {
        console.error(`[auth] ${authErrorType(error)}`);
      },
    },
    callbacks: {
      signIn({ account, profile, user }) {
        const email = account?.provider === "google" ? profile?.email : user.email;
        return isAllowedSignIn(
          { provider: account?.provider, email, emailVerified: profile?.email_verified },
          settings.ownerEmail,
          previewProviderId,
        );
      },
    },
  };
}
