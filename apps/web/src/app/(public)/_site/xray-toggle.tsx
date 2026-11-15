"use client";
// The header's X-ray switch. Off by default; the choice is kept for the browser session.
import { useSyncExternalStore } from "react";
import h from "./site-header.module.css";
import { getXray, getXrayServer, setXray, subscribeXray } from "./xray-state";

export function XrayToggle() {
  const on = useSyncExternalStore(subscribeXray, getXray, getXrayServer);
  return (
    <button type="button" className={h.xray} aria-pressed={on} onClick={() => setXray(!on)}>
      X-ray
    </button>
  );
}
