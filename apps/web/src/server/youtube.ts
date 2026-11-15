// YouTube channel statistics for the social-daily job (wave 2 design, section 3). One channels.list call
// (1 quota unit). Never log tokens or response bodies: callers get a fixed error code only.

export const YOUTUBE_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true";

/** Fixed failure codes shared by the platform clients. */
export type PlatformFailure = "network" | "unauthorized" | "http" | "bad_response";

export class PlatformError extends Error {
  constructor(readonly code: PlatformFailure) {
    super(code);
    this.name = "PlatformError";
  }
}

export interface YoutubeStats {
  /** Rounded down by YouTube to three significant figures, so never exact. Null when the channel hides it. */
  followers: number | null;
  /** Cumulative views across all videos. */
  views: number | null;
}

function count(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

/**
 * The one place that knows the channels.list response shape (field names UNVERIFIED beyond the research notes:
 * statistics.subscriberCount, viewCount and hiddenSubscriberCount, all counts as decimal strings).
 * Throws PlatformError("bad_response") for anything unexpected.
 */
export function parseChannelStats(body: unknown): YoutubeStats {
  const items = (body as { items?: unknown } | null)?.items;
  const stats = Array.isArray(items) ? (items[0] as { statistics?: unknown } | undefined)?.statistics : undefined;
  if (typeof stats !== "object" || stats === null) throw new PlatformError("bad_response");
  const s = stats as Record<string, unknown>;
  const views = count(s.viewCount);
  const followers = s.hiddenSubscriberCount === true ? null : count(s.subscriberCount);
  if (views === null) throw new PlatformError("bad_response");
  if (followers === null && s.hiddenSubscriberCount !== true) throw new PlatformError("bad_response");
  return { followers, views };
}

/** Reads the owner's channel statistics with a Google access token. Throws PlatformError. */
export async function fetchYoutubeStats(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<YoutubeStats> {
  let res: Response;
  try {
    res = await fetchImpl(YOUTUBE_CHANNELS_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PlatformError("network");
  }
  if (res.status === 401) throw new PlatformError("unauthorized");
  if (!res.ok) throw new PlatformError("http");
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new PlatformError("bad_response");
  }
  return parseChannelStats(body);
}
