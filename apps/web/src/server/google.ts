// The Google connections (D15). The owner's refresh token lives in the secret named by KCW_GOOGLE_TOKEN_SECRET
// (written at sign-in by auth/config.ts events.signIn); the dummy calendar account's (public log, PL7) in the secret
// named by KCW_GOOGLE_DEMO_TOKEN_SECRET (written by the demo consent, server/demo-consent.ts). This module turns a
// stored token into short-lived access tokens and can disconnect; each account has its own store and cache. Never log tokens, the client secret or response bodies: only fixed codes and error classes.
import { defaultSecretStore, SecretKeyMissingError, SecretNotFoundError } from "@kcw/secrets";
import { patchOrCreateSecret, GOOGLE_CALENDAR_SCOPE, GOOGLE_DEMO_TOKEN_SECRET_ENV, GOOGLE_TOKEN_SECRET_ENV } from "../auth/google-consent";
import { loadProdSettings } from "../auth/settings";

export type GoogleScope = "calendar";

const API_SCOPE: Record<GoogleScope, string> = {
  calendar: GOOGLE_CALENDAR_SCOPE,
};

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** No call to Google may hold a request or a scheduled job until the function times out. */
export const GOOGLE_TIMEOUT_MS = 8000;
/** Refresh this many seconds before Google says the token expires. */
const EXPIRY_MARGIN_S = 60;

export interface StoredGoogleToken {
  refreshToken: string;
  scope: string;
  connectedAt: string;
}

/** What the module needs from the outside. Defaults: global fetch, the process secret store, the auth settings. */
export interface GoogleDeps {
  fetch?: typeof fetch;
  /** Reads the stored token (null: nothing stored or not configured) and patches its keys. */
  store?: {
    read(): Promise<StoredGoogleToken | null>;
    patch(patch: Readonly<Record<string, string>>): Promise<void>;
  };
  /** Null when Google client settings are not available (previews). */
  client?: () => Promise<{ clientId: string; clientSecret: string } | null>;
  now?: () => number;
}

export interface GoogleConnection {
  /** The token secret name is set and Google client settings exist. False in previews. */
  configured: boolean;
  connected: boolean;
  scopes: GoogleScope[];
  /** ISO time of the consent; kept after a rejected token so the page can say "Reconnect". */
  connectedAt: string | null;
  /** Google rejected the stored token (it was cleared): the owner has to connect again. */
  expired: boolean;
}

function storeFor(env: string): NonNullable<GoogleDeps["store"]> {
  const tokenSecretName = (): string | undefined => process.env[env] || undefined;
  return {
    async read() {
      const name = tokenSecretName();
      if (!name) return null;
      const store = defaultSecretStore();
      // Another server instance may have written since this one cached the secret.
      store.clearCache(name);
      try {
        const value = await store.get(name);
        if (typeof value === "string") return null;
        const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
        return { refreshToken: text("refresh_token"), scope: text("scope"), connectedAt: text("connected_at") };
      } catch (err) {
        if (err instanceof SecretNotFoundError || err instanceof SecretKeyMissingError) return null;
        console.error(`[google] read failed ${errorClass(err)}`);
        return null;
      }
    },
    async patch(patch) {
      const name = tokenSecretName();
      if (name) await patchOrCreateSecret(name, patch);
    },
  };
}

// Reads the client settings without importing "../auth": the scheduled jobs bundle this module into the
// OpenNext wrapper, and "../auth" would pull NextAuth and the preview-only login module into that prod bundle
// (scripts/check-prod-bundle.ts). Previews have no Google client.
async function defaultClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  if (process.env.KCW_ENV === "preview") return null;
  return (await loadProdSettings(process.env, defaultSecretStore())).google ?? null;
}

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

function parseScopes(scope: string): GoogleScope[] {
  const granted = scope.split(" ");
  return (Object.keys(API_SCOPE) as GoogleScope[]).filter((k) => granted.includes(API_SCOPE[k]));
}

/** One Google account: its token secret (named by an env var), its in-memory access token, connect state and disconnect. */
export interface GoogleAccount {
  /**
   * A short-lived access token for the Calendar API, or null when the account is not connected, the stored
   * consent lacks that scope, or the refresh failed. Tokens are cached in memory until a minute before expiry.
   */
  accessToken(scope: GoogleScope, deps?: GoogleDeps): Promise<string | null>;
  /** The connection state for /connections. */
  connection(deps?: GoogleDeps): Promise<GoogleConnection>;
  /** Revokes the refresh token at Google, then clears the stored token. False when nothing was done or a step failed. */
  disconnect(deps?: GoogleDeps): Promise<boolean>;
  /** Forget the in-memory access token (tests, disconnect, a rejected token). */
  resetCache(): void;
  /** The name of the env var holding the token secret's name. */
  readonly secretEnv: string;
}

function googleAccount(secretEnv: string): GoogleAccount {
  const defaultStore = storeFor(secretEnv);
  let cached: { token: string; scope: string; expiresAt: number } | undefined;
  const resetGoogleCache = (): void => {
    cached = undefined;
  };

  async function googleAccessToken(scope: GoogleScope, deps: GoogleDeps = {}): Promise<string | null> {
    const now = (deps.now ?? Date.now)();
    const need = API_SCOPE[scope];
    if (cached && cached.expiresAt > now && cached.scope.split(" ").includes(need)) return cached.token;

    const store = deps.store ?? defaultStore;
    const stored = await store.read();
    if (!stored?.refreshToken || !stored.scope.split(" ").includes(need)) return null;
    const client = await (deps.client ?? defaultClient)();
    if (!client) return null;

    let res: Response;
    try {
      res = await (deps.fetch ?? fetch)(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: stored.refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        }),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch (err) {
      console.error(`[google] refresh failed ${errorClass(err)}`);
      return null;
    }

    let body: { access_token?: unknown; expires_in?: unknown; error?: unknown } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // Not JSON: treated as a failed refresh below.
    }
    if (!res.ok) {
      if (body.error === "invalid_grant") {
        console.error("[google] google_token_invalid");
        try {
          // Keeps scope and connected_at so the page can tell "rejected" from "never connected".
          await store.patch({ refresh_token: "" });
        } catch (err) {
          console.error(`[google] store failed ${errorClass(err)}`);
        }
        resetGoogleCache();
      } else {
        console.error(`[google] refresh failed ${res.status}`);
      }
      return null;
    }
    if (typeof body.access_token !== "string" || !body.access_token) {
      console.error("[google] refresh failed bad_response");
      return null;
    }
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
    cached = {
      token: body.access_token,
      scope: stored.scope,
      expiresAt: now + Math.max(0, lifetime - EXPIRY_MARGIN_S) * 1000,
    };
    return body.access_token;
  }

  async function googleConnection(deps: GoogleDeps = {}): Promise<GoogleConnection> {
    const configured = Boolean(deps.store ?? process.env[secretEnv]) && Boolean(await (deps.client ?? defaultClient)());
    if (!configured) return { configured, connected: false, scopes: [], connectedAt: null, expired: false };
    const stored = await (deps.store ?? defaultStore).read();
    const connectedAt = stored?.connectedAt || null;
    const connected = Boolean(stored?.refreshToken);
    return {
      configured,
      connected,
      scopes: connected && stored ? parseScopes(stored.scope) : [],
      connectedAt,
      expired: !connected && connectedAt !== null,
    };
  }

  async function disconnectGoogle(deps: GoogleDeps = {}): Promise<boolean> {
    const store = deps.store ?? defaultStore;
    const stored = await store.read();
    if (!stored?.refreshToken) return false;
    let revoked = false;
    try {
      const res = await (deps.fetch ?? fetch)(REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: stored.refreshToken }),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
      // 400 means Google no longer knows the token (already revoked): the goal is reached either way.
      revoked = res.ok || res.status === 400;
      if (!revoked) console.error(`[google] revoke failed ${res.status}`);
    } catch (err) {
      console.error(`[google] revoke failed ${errorClass(err)}`);
    }
    if (!revoked) return false;
    try {
      await store.patch({ refresh_token: "", scope: "", connected_at: "" });
    } catch (err) {
      console.error(`[google] store failed ${errorClass(err)}`);
      return false;
    }
    resetGoogleCache();
    return true;
  }

  return { accessToken: googleAccessToken, connection: googleConnection, disconnect: disconnectGoogle, resetCache: resetGoogleCache, secretEnv };
}

/** The owner's account (the Add button of calendar suggestions). */
export const ownerGoogle = googleAccount(GOOGLE_TOKEN_SECRET_ENV);
/** The dummy calendar account of the public log (PL7); never the owner's. */
export const demoGoogle = googleAccount(GOOGLE_DEMO_TOKEN_SECRET_ENV);

/** The owner's access token (see GoogleAccount.accessToken). */
export const googleAccessToken = (scope: GoogleScope, deps: GoogleDeps = {}): Promise<string | null> => ownerGoogle.accessToken(scope, deps);
/** The owner's connection state for /connections. */
export const googleConnection = (deps: GoogleDeps = {}): Promise<GoogleConnection> => ownerGoogle.connection(deps);
/** Revokes and clears the owner's token. */
export const disconnectGoogle = (deps: GoogleDeps = {}): Promise<boolean> => ownerGoogle.disconnect(deps);
/** Forget the owner's in-memory access token. */
export const resetGoogleCache = (): void => ownerGoogle.resetCache();

/** The Google client and the owner address (null in previews or when missing). Used by the demo consent. */
export async function demoConsentSettings(): Promise<{ clientId: string; clientSecret: string; ownerEmail: string } | null> {
  if (process.env.KCW_ENV === "preview") return null;
  const settings = await loadProdSettings(process.env, defaultSecretStore());
  return settings.google ? { ...settings.google, ownerEmail: settings.ownerEmail } : null;
}
