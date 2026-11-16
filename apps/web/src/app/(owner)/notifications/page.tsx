import type { Metadata } from "next";
import { DbNotConfiguredError, dbErrorLabel, withDb } from "@/server/db";
import { requireOwner } from "@/server/owner";
import { loadVapidKeys } from "@/server/push/keys";
import { countSubscriptions } from "@/server/push/subscriptions";
import { OwnerFrame } from "../owner-frame";
import { Region } from "../owner-ui";
import s from "../owner.module.css";
import { PushPanel } from "./push-panel";

export const metadata: Metadata = { title: "Notifications | Kentcrosswise" };

export default async function NotificationsPage() {
  await requireOwner();
  const keys = await loadVapidKeys().catch((err: unknown) => {
    console.error(`[push] keys failed ${err instanceof Error ? err.name : "error"}`);
    return null;
  });
  let devices: number | null = null;
  if (keys) {
    devices = await withDb("web_rw", countSubscriptions, { readOnly: true }).catch((err: unknown) => {
      if (!(err instanceof DbNotConfiguredError)) console.error(`[push] count failed ${dbErrorLabel(err)}`);
      return null;
    });
  }
  return (
    <OwnerFrame title="Notifications" current="/notifications">
      <Region id="push" title="Web push" testId="push">
        <div className={`${s.pad} ${s.stack}`}>
          <p className={s.note}>
            One generic notification when new items wait in your inbox. It never contains the item text. On iPhone, add
            this site to the Home Screen first and open it from there.
          </p>
          {keys ? (
            <>
              <PushPanel publicKey={keys.publicKey} />
              {devices !== null ? (
                <p className={s.muted} data-testid="device-count">
                  {devices} {devices === 1 ? "device" : "devices"} subscribed.
                </p>
              ) : null}
            </>
          ) : (
            <p className={s.emph}>Push is not set up here (the notification keys are missing), so it cannot be turned on.</p>
          )}
        </div>
      </Region>
    </OwnerFrame>
  );
}
