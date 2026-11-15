// Instagram API with Instagram Login, for the social-daily job (wave 2 design, section 3). The owner pastes the
// long-lived token into the secret named by KCW_INSTAGRAM_SECRET (keys app_id, app_secret, long_lived_token,
// refreshed_at); this module reads the follower count and refreshes the token when it is 25 days old or more.
// Never log tokens or response bodies: callers get a fixed error code only.
import { defaultSecretStore, SecretKeyMissingError, SecretNotFoundError } from "@kcw/secrets";
import { PlatformError } from "./youtube";

export const INSTAGRAM_SECRET_ENV = "KCW_INSTAGRAM_SECRET";
/** Graph API version in the URL. UNVERIFIED that this is current; change it here only. */
export const INSTAGRAM_API_VERSION = "v23.0";
export const REFRESH_AFTER_DAYS = 25;
const DAY_MS = 86_400_000;

export interface InstagramToken {
  token: string;
  /** ISO date or time of the last refresh (or paste); empty when missing. */
  refreshedAt: string;
}

/** Reads and patches the token secret. Defaults to the process secret store. */
export interface InstagramStore {
  /** Null when the secret is not configured, not found, or holds no token. */
  read(): Promise<InstagramToken | null>;
  patch(patch: Readonly<Record<string, string>>): Promise<void>;
}

export const defaultInstagramStore: InstagramStore = {
  async read() {
    const name = process.env[INSTAGRAM_SECRET_ENV];
    if (!name) return null;
    try {
      const value = await defaultSecretStore().get(name);
      if (typeof value === "string") return null;
      const token = value.long_lived_token;
      if (typeof token !== "string" || !token) return null;
      return { token, refreshedAt: typeof value.refreshed_at === "string" ? value.refreshed_at : "" };
    } catch (err) {
      if (err instanceof SecretNotFoundError || err instanceof SecretKeyMissingError) return null;
      throw err;
    }
  },
  async patch(patch) {
    const name = process.env[INSTAGRAM_SECRET_ENV];
    if (name) await defaultSecretStore().patch(name, patch);
  },
};

/** True when the token is 25 or more days past its last refresh. A missing or unreadable date counts as due. */
export function refreshDue(refreshedAt: string, now: number): boolean {
  const at = Date.parse(refreshedAt);
  return Number.isNaN(at) || now - at >= REFRESH_AFTER_DAYS * DAY_MS;
}

async function getJson(url: string, fetchImpl: typeof fetch, headers?: Record<string, string>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new PlatformError("network");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 401) throw new PlatformError("unauthorized");
  // Meta reports an expired or invalid token as HTTP 400 with error code 190.
  if (res.status === 400 && (body as { error?: { code?: unknown } } | undefined)?.error?.code === 190) {
    throw new PlatformError("unauthorized");
  }
  if (!res.ok) throw new PlatformError("http");
  if (body === undefined) throw new PlatformError("bad_response");
  return body;
}

/**
 * The one place that knows the /me response shape. The /me shortcut and the field name followers_count are
 * UNVERIFIED (research notes); fallback is an owner-pasted ig_user_id and /<id>?fields=followers_count.
 */
export function parseFollowers(body: unknown): number {
  const n = (body as { followers_count?: unknown } | null)?.followers_count;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new PlatformError("bad_response");
  return n;
}

/** The account's current follower count. Throws PlatformError. */
export async function fetchInstagramFollowers(token: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const url = `https://graph.instagram.com/${INSTAGRAM_API_VERSION}/me?fields=user_id,username,followers_count`;
  return parseFollowers(await getJson(url, fetchImpl, { authorization: `Bearer ${token}` }));
}

/** Exchange for a new 60-day token (valid when the old one is at least 24 h old and not expired). Throws PlatformError. */
export async function refreshInstagramToken(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
  const body = await getJson(url, fetchImpl);
  const next = (body as { access_token?: unknown } | null)?.access_token;
  if (typeof next !== "string" || !next) throw new PlatformError("bad_response");
  return next;
}
