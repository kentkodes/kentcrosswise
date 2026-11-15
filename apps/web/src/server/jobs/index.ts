// Scheduled web-side jobs (wave 2 design, section 1). EventBridge Scheduler invokes the server
// Lambda with {"kcw_job": "<name>", "scheduled_time": "..."}; ../origin-wrapper routes that
// payload here before the origin check. Jobs run outside any HTTP request: they must not import
// next/headers, server-only or anything else that needs a request.
import { inboxPush } from "./inbox-push";
import { socialDaily } from "./social-daily";

export interface JobContext {
  /** The schedule's own scheduled time (ISO 8601), when the payload carries one. */
  scheduledTime: string | undefined;
}

/** What a job reports: a fixed code and counters, never data. */
export interface JobOutcome {
  code: string;
  counts?: Record<string, number>;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;
export type JobRegistry = Readonly<Record<string, JobHandler>>;

export const jobs: JobRegistry = {
  "social-daily": socialDaily,
  "inbox-push": inboxPush,
};
