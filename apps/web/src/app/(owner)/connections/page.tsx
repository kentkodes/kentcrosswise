import type { Metadata } from "next";
import { demoGoogle, googleConnection } from "@/server/google";
import { withDb } from "../../../server/db";
import { demoCalendarStatus, type DemoCalendarStatus } from "../../../server/demo-calendar";
import { requireOwner } from "@/server/owner";
import { OwnerFrame } from "../owner-frame";
import { Notice } from "../owner-ui";
import { ConnectionView, DemoCalendarView } from "./connection-view";
import { connectionNotice, OK_NOTICES, type ConnectionNoticeCode } from "./notices";

/** The demo calendar's stored state; null when there is no database (previews without one) or it fails. */
async function loadDemoStatus(): Promise<DemoCalendarStatus | null> {
  try {
    return await withDb("web_rw", (db) => demoCalendarStatus(db), { readOnly: true });
  } catch (err) {
    console.error(`[connections] demo-status ${err instanceof Error ? err.name : "error"}`);
    return null;
  }
}

export const metadata: Metadata = { title: "Connections | Kentcrosswise" };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const params = await searchParams;
  const notice = connectionNotice(params.n);
  const [conn, demo, demoStatus] = await Promise.all([googleConnection(), demoGoogle.connection(), loadDemoStatus()]);
  return (
    <OwnerFrame title="Connections" current="/connections">
      {notice ? (
        <Notice role="status" tone={OK_NOTICES.includes(params.n as ConnectionNoticeCode) ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}
      <ConnectionView conn={conn} confirming={params.confirm === "disconnect"} />
      <DemoCalendarView conn={demo} status={demoStatus} confirming={params.confirm === "demo-disconnect"} />
    </OwnerFrame>
  );
}
