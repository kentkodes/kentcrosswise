"use client";
// The device controls on /notifications. The permission prompt and the subscription both start from a tap.
import { useEffect, useState, useTransition } from "react";
import { Dot, Notice } from "../owner-ui";
import s from "../owner.module.css";
import { removeSubscriptionAction, saveSubscriptionAction, sendTestAction } from "./actions";
import { type PushNoticeCode, pushNotice } from "./notices";
import n from "./notifications.module.css";

type Support = "checking" | "yes" | "no";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushPanel({ publicKey }: { publicKey: string }) {
  const [support, setSupport] = useState<Support>("checking");
  const [subscribed, setSubscribed] = useState(false);
  const [notice, setNotice] = useState<PushNoticeCode | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setSupport(ok ? "yes" : "no");
    if (!ok) return;
    void navigator.serviceWorker
      .register("/sw.js")
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setSubscribed(sub !== null))
      .catch(() => undefined);
  }, []);

  const enable = () =>
    start(async () => {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return setNotice("denied");
        const reg = await navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
        const code = await saveSubscriptionAction(sub.toJSON());
        if (code !== "saved") await sub.unsubscribe().catch(() => undefined);
        setSubscribed(code === "saved");
        setNotice(code);
      } catch {
        setNotice("subscribe-failed");
      }
    });

  const disable = () =>
    start(async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe();
          setNotice(await removeSubscriptionAction(endpoint));
        } else setNotice("removed");
        setSubscribed(false);
      } catch {
        setNotice("subscribe-failed");
      }
    });

  const test = () => start(async () => setNotice(await sendTestAction()));

  if (support === "checking") return <p className={s.muted}>Checking this browser...</p>;
  if (support === "no") {
    return <p className={s.muted}>This browser does not support web push, so notifications cannot be turned on here.</p>;
  }
  const text = notice ? pushNotice(notice) : null;
  return (
    <div className={`${s.stack} ${n.wrap}`}>
      <p className={s.emph}>
        <Dot tone={subscribed ? "ok" : "warn"} /> {subscribed ? "On for this device" : "Off for this device"}
      </p>
      <div className={s.formRow}>
        {subscribed ? (
          <button type="button" className={`${s.button} ${s.tapTarget}`} disabled={pending} onClick={disable}>
            Disable
          </button>
        ) : (
          <button type="button" className={`${s.button} ${s.primary} ${s.tapTarget}`} disabled={pending} onClick={enable}>
            Enable notifications
          </button>
        )}
        <button type="button" className={`${s.button} ${s.tapTarget}`} disabled={pending} onClick={test}>
          Send test
        </button>
      </div>
      {text ? (
        <Notice role="status" tone={notice === "saved" || notice === "removed" || notice === "test-sent" ? "ok" : "warn"}>
          {text}
        </Notice>
      ) : null}
    </div>
  );
}
