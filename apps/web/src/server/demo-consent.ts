// The demo calendar consent (public log PL7, DESIGN §4.6 "Calendar"). Not the owner sign-in: a separate OAuth flow
// for the dummy Google account, with its own state, PKCE verifier and callback (/connections/demo/callback). It asks
// for the account's address and its own calendar's events (GOOGLE_DEMO_SCOPES), refuses the owner's own account
// (its token is revoked, never stored), and stores the refresh token in the secret named by
// KCW_GOOGLE_DEMO_TOKEN_SECRET. The account's address is the calendar id that the public log links to.
// Never log tokens, codes, addresses or response bodies: only fixed codes and error classes.
import { createHash, randomBytes } from "node:crypto";
import { isOwnerEmail } from "../auth/allowlist";
import { GOOGLE_CALENDAR_SCOPE, GOOGLE_DEMO_SCOPES, GOOGLE_DEMO_TOKEN_SECRET_ENV, patchOrCreateSecret } from "../auth/google-consent";
import { GOOGLE_TIMEOUT_MS, REVOKE_URL, TOKEN_URL } from "./google";

export const DEMO_CALLBACK_PATH = "/connections/demo/callback";
/** The cookie that carries the state and the PKCE verifier from the Connect button to the callback. */
export const DEMO_CONSENT_COOKIE = "kcw_demo_consent";
export const DEMO_CONSENT_MAX_AGE_S = 600;
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** The same address the demo_calendar table accepts (0029). */
const CALENDAR_ID = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}$/;

const b64url = (buf: Buffer): string => buf.toString("base64url");

export interface DemoConsentStart {
  state: string;
  verifier: string;
  url: string;
  /** The cookie value: state and verifier, both base64url (no dots). */
  cookie: string;
}

/** The site's origin as the viewer sees it: CloudFront forwards the viewer host in x-forwarded-host. */
export function siteOrigin(headers: { get(name: string): string | null }): string | null {
  const host = (headers.get("x-forwarded-host") ?? headers.get("host") ?? "").split(",")[0]!.trim();
  if (!/^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return null;
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

export const demoRedirectUri = (origin: string): string => `${origin}${DEMO_CALLBACK_PATH}`;

/** A fresh state and PKCE pair, and the Google consent URL for the dummy account. */
export function startDemoConsent(clientId: string, redirectUri: string, random: (n: number) => Buffer = randomBytes): DemoConsentStart {
  const state = b64url(random(24));
  const verifier = b64url(random(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_DEMO_SCOPES,
    access_type: "offline",
    // Always a refresh token, and always the account chooser: the owner picks the dummy account, not the signed-in one.
    prompt: "consent select_account",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { state, verifier, url: `${AUTH_URL}?${params.toString()}`, cookie: `${state}.${verifier}` };
}

/** The state and verifier from the cookie, or null when it is missing or malformed. */
export function readConsentCookie(value: string | undefined): { state: string; verifier: string } | null {
  const m = /^([A-Za-z0-9_-]{32})\.([A-Za-z0-9_-]{64})$/.exec(value ?? "");
  return m ? { state: m[1]!, verifier: m[2]! } : null;
}

/** Fixed outcome codes of the callback; /connections maps each to one notice. */
export type DemoConsentOutcome =
  | "connected"
  | "denied"
  | "bad-state"
  | "owner-account"
  | "unverified"
  | "no-calendar"
  | "no-token"
  | "not-configured"
  | "failed";

export interface FinishDeps {
  fetch?: typeof fetch;
  /** Patches the token secret (default: the secret named by KCW_GOOGLE_DEMO_TOKEN_SECRET). */
  patch?: (patch: Readonly<Record<string, string>>) => Promise<void>;
  now?: () => Date;
}

function claims(idToken: unknown): { email: string | null; verified: boolean } {
  // The ID token comes straight from Google's token endpoint over TLS, so its claims can be read without checking
  // the signature (OpenID Connect Core 3.1.3.7, item 6).
  if (typeof idToken !== "string") return { email: null, verified: false };
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return { email: typeof payload.email === "string" ? payload.email : null, verified: payload.email_verified === true };
  } catch {
    return { email: null, verified: false };
  }
}

async function revoke(token: string, f: typeof fetch): Promise<void> {
  try {
    await f(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[demo-consent] revoke ${err instanceof Error ? err.name : "Error"}`);
  }
}

/**
 * Exchanges the code for tokens and stores the refresh token. Refuses the owner's own account and an address that is
 * not verified (the token is revoked, nothing stored), a consent without the calendar scope and one without a
 * refresh token. Never throws: provider and network errors are "failed".
 */
export async function finishDemoConsent(
  input: { code: string; verifier: string; redirectUri: string },
  settings: { clientId: string; clientSecret: string; ownerEmail: string },
  deps: FinishDeps = {},
): Promise<{ outcome: DemoConsentOutcome; calendarId?: string }> {
  const f = deps.fetch ?? fetch;
  let body: { refresh_token?: unknown; access_token?: unknown; scope?: unknown; id_token?: unknown } = {};
  try {
    const res = await f(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
        client_id: settings.clientId,
        client_secret: settings.clientSecret,
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[demo-consent] exchange ${res.status}`);
      return { outcome: "failed" };
    }
    body = (await res.json()) as typeof body;
  } catch (err) {
    console.error(`[demo-consent] exchange ${err instanceof Error ? err.name : "Error"}`);
    return { outcome: "failed" };
  }

  const refresh = typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null;
  const access = typeof body.access_token === "string" && body.access_token ? body.access_token : null;
  const scope = typeof body.scope === "string" ? body.scope : "";
  const { email, verified } = claims(body.id_token);
  const drop = async (outcome: DemoConsentOutcome) => {
    const token = refresh ?? access;
    if (token) await revoke(token, f);
    return { outcome };
  };

  if (email !== null && isOwnerEmail(email, settings.ownerEmail)) return drop("owner-account");
  if (email === null || !verified || !CALENDAR_ID.test(email)) return drop("unverified");
  if (!scope.split(" ").includes(GOOGLE_CALENDAR_SCOPE)) return drop("no-calendar");
  if (!refresh) return drop("no-token");

  try {
    const patch = deps.patch ?? ((p) => storeDemoToken(p));
    await patch({ refresh_token: refresh, scope, connected_at: (deps.now?.() ?? new Date()).toISOString() });
  } catch (err) {
    console.error(`[demo-consent] store ${err instanceof Error ? err.name : "Error"}`);
    return drop("failed");
  }
  return { outcome: "connected", calendarId: email };
}

async function storeDemoToken(patch: Readonly<Record<string, string>>): Promise<void> {
  const name = process.env[GOOGLE_DEMO_TOKEN_SECRET_ENV];
  if (!name) throw new Error("not configured");
  await patchOrCreateSecret(name, patch);
}
