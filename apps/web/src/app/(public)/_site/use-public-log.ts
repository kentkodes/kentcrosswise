"use client";
// Loads the public log once per page view from the cached public endpoint (s-maxage 30). No polling: a published
// record changes only when the owner acts on it.
import { useEffect, useState } from "react";
import { LOG_URL, parsePublicLog, type PublicLog } from "./public-log";

export type LogState = { status: "loading" } | { status: "error" } | { status: "ready"; log: PublicLog };

export function usePublicLog(): LogState {
  const [state, setState] = useState<LogState>({ status: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(LOG_URL, { signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: unknown) => {
        const log = parsePublicLog(json);
        setState(log ? { status: "ready", log } : { status: "error" });
      })
      .catch((err: unknown) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, []);
  return state;
}
