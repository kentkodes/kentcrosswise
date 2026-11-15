import type { NextAuthConfig } from "next-auth";
import type { Provider } from "next-auth/providers";
import Google from "next-auth/providers/google";
import { isAllowedSignIn } from "./allowlist";
import {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_SIGN_IN_SCOPES,
  GOOGLE_TOKEN_SECRET_ENV,
  GOOGLE_YOUTUBE_SCOPE,
  patchOrCreateSecret,
} from "./google-consent";
import type { AuthSettings } from "./settings";

export {
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CONNECT_SCOPES,
  GOOGLE_SIGN_IN_SCOPES,
  GOOGLE_TOKEN_SECRET_ENV,
  GOOGLE_YOUTUBE_SCOPE,
  patchOrCreateSecret,
} from "./google-consent";

type PatchSecret = (name: string, patch: Readonly<Record<string, string>>) => Promise<void>;

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
  /** Injectable for tests; defaults to the process secret store and env. */
  google: { secretName?: string; patch?: PatchSecret; now?: () => Date } = {},
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
    events: {
      // Runs after the signIn callback accepted the sign-in. Only a consent that granted both API scopes with a
      // refresh token is stored; ordinary sign-ins carry no refresh token and write nothing. Never throws: a failed
      // write must not break the sign-in, and nothing but the error class is logged.
      async signIn({ account }) {
        if (account?.provider !== "google" || !account.refresh_token) return;
        const granted = (account.scope ?? "").split(" ");
        if (!granted.includes(GOOGLE_CALENDAR_SCOPE) || !granted.includes(GOOGLE_YOUTUBE_SCOPE)) return;
        const name = google.secretName ?? process.env[GOOGLE_TOKEN_SECRET_ENV];
        if (!name) return;
        try {
          const patch = google.patch ?? patchOrCreateSecret;
          await patch(name, {
            refresh_token: account.refresh_token,
            scope: account.scope ?? "",
            connected_at: (google.now?.() ?? new Date()).toISOString(),
          });
        } catch (err) {
          console.error(`[google] store failed ${err instanceof Error ? err.name : "Error"}`);
        }
      },
    },
  };
}
