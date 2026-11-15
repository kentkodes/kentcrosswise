import type { Metadata } from "next";
import { googleConnection } from "@/server/google";
import { requireOwner } from "@/server/owner";
import { OwnerFrame } from "../owner-frame";
import { Notice } from "../owner-ui";
import { ConnectionView } from "./connection-view";
import { connectionNotice } from "./notices";

export const metadata: Metadata = { title: "Connections | Kentcrosswise" };

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const params = await searchParams;
  const notice = connectionNotice(params.n);
  const conn = await googleConnection();
  return (
    <OwnerFrame title="Connections" current="/hub">
      {notice ? (
        <Notice role="status" tone={params.n === "disconnected" ? "ok" : "warn"}>
          {notice}
        </Notice>
      ) : null}
      <ConnectionView conn={conn} confirming={params.confirm === "disconnect"} />
    </OwnerFrame>
  );
}
