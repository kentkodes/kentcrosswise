// The social-daily job (wave 2 design, section 3): one snapshot a day for the owner's YouTube and Instagram
// accounts (the single ingest='api' account per platform), plus the Instagram token refresh when it is due.
// TikTok stays manual. Logs one line per platform with fixed codes and error classes only: never tokens,
// handles, account ids or response bodies.
import { withDb, type Queryable } from "../db";
import { googleAccessToken } from "../google";
import {
  defaultInstagramStore,
  fetchInstagramFollowers,
  refreshDue,
  refreshInstagramToken,
  type InstagramStore,
} from "../instagram";
import { todayUtc, upsertSnapshot } from "../social";
import { fetchYoutubeStats, PlatformError } from "../youtube";
import type { JobContext, JobHandler, JobOutcome } from "./index";

export type SocialPlatformCode = "ok" | "not_connected" | "no_account" | "network" | "unauthorized" | "http" | "bad_response" | "store";

export class SocialDailyFailedError extends Error {
  constructor() {
    super("social-daily failed");
    this.name = "SocialDailyFailedError";
  }
}

export interface SocialDailyDeps {
  run?: <T>(fn: (db: Queryable) => Promise<T>) => Promise<T>;
  fetch?: typeof fetch;
  googleToken?: () => Promise<string | null>;
  instagram?: InstagramStore;
  now?: () => number;
  log?: (line: string) => void;
}

interface Result {
  code: SocialPlatformCode;
  /** Extra log detail: a fixed code or error class. */
  note?: string;
}

function failure(err: unknown): Result {
  if (err instanceof PlatformError) return { code: err.code };
  return { code: "store", note: err instanceof Error ? err.name : "Error" };
}

/** The UTC day of the schedule's time, or today when the payload has none or it is unreadable. */
function dayOf(scheduledTime: string | undefined, now: number): string {
  const t = scheduledTime ? new Date(scheduledTime) : undefined;
  return todayUtc(t && !Number.isNaN(t.getTime()) ? t : new Date(now));
}

export async function runSocialDaily(ctx: JobContext, deps: SocialDailyDeps = {}): Promise<JobOutcome> {
  const run = deps.run ?? ((fn) => withDb("web_rw", fn));
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.log(line));
  const day = dayOf(ctx.scheduledTime, now());

  const accounts = await run(async (db) => {
    const { rows } = await db.query<{ platform: string; id: string }>(
      `SELECT DISTINCT ON (platform) platform, id FROM social_accounts
        WHERE ingest = 'api' AND platform IN ('youtube', 'instagram') ORDER BY platform, handle`,
    );
    return new Map(rows.map((r) => [r.platform, r.id]));
  });

  const write = (accountId: string, followers: number | null, views: number | null, followersExact: boolean) =>
    run((db) => upsertSnapshot(db, { accountId, day, followers, views, followersExact }));

  const youtube = async (accountId: string): Promise<Result> => {
    const token = await (deps.googleToken ?? (() => googleAccessToken("youtube")))();
    if (!token) return { code: "not_connected" };
    const stats = await fetchYoutubeStats(token, fetchImpl);
    await write(accountId, stats.followers, stats.views, false);
    return { code: "ok" };
  };

  const instagram = async (accountId: string): Promise<Result> => {
    const store = deps.instagram ?? defaultInstagramStore;
    const stored = await store.read();
    if (!stored) return { code: "not_connected" };
    let token = stored.token;
    let note: string | undefined;
    if (refreshDue(stored.refreshedAt, now())) {
      try {
        token = await refreshInstagramToken(token, fetchImpl);
        try {
          await store.patch({ long_lived_token: token, refreshed_at: new Date(now()).toISOString() });
          note = "refresh=ok";
        } catch (err) {
          note = `refresh=store_failed ${err instanceof Error ? err.name : "Error"}`;
        }
      } catch (err) {
        note = `refresh=${err instanceof PlatformError ? err.code : "failed"}`;
      }
    }
    const followers = await fetchInstagramFollowers(token, fetchImpl);
    await write(accountId, followers, null, true);
    return { code: "ok", note };
  };

  const platforms = [
    ["youtube", youtube],
    ["instagram", instagram],
  ] as const;
  const counts: Record<string, number> = { written: 0, skipped: 0, failed: 0 };
  for (const [name, fn] of platforms) {
    let result: Result;
    const accountId = accounts.get(name);
    if (!accountId) result = { code: "no_account" };
    else {
      try {
        result = await fn(accountId);
      } catch (err) {
        result = failure(err);
      }
    }
    log(`[social-daily] ${name} ${result.code}${result.note ? ` ${result.note}` : ""}`);
    if (result.code === "ok") counts.written = (counts.written ?? 0) + 1;
    else if (result.code === "not_connected" || result.code === "no_account") counts.skipped = (counts.skipped ?? 0) + 1;
    else counts.failed = (counts.failed ?? 0) + 1;
  }
  // Every platform has run; now let the async invoke count the error.
  if (counts.failed) throw new SocialDailyFailedError();
  return { code: counts.written ? "ok" : "off", counts };
}

export const socialDaily: JobHandler = (ctx) => runSocialDaily(ctx);
