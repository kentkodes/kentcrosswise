"use client";
// The header's account link. Pages stay static: the server always renders "Sign in"; after mount
// the browser asks the existing Auth.js session endpoint and, if a user is present, the same link
// becomes "Your hub" (/hub). Errors and timeouts keep "Sign in". Both labels share one grid cell,
// so the pill keeps the width of the longer label and nothing shifts when it swaps.
import { useEffect, useState } from "react";
import h from "./site-header.module.css";

const SESSION_URL = "/api/auth/session";
const TIMEOUT_MS = 5_000;

/** True if an Auth.js session response body carries a user. */
function hasUser(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const user = (body as { user?: unknown }).user;
  return typeof user === "object" && user !== null;
}

export function AccountLink() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    fetch(SESSION_URL, { credentials: "include", cache: "no-store", signal: ctrl.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (hasUser(body)) setSignedIn(true);
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, []);

  return (
    // One element for both states, so focus survives the swap. A plain link: the sign-in route
    // is an Auth.js handler that needs a full page load.
    <a className={h.signIn} href={signedIn ? "/hub" : "/api/auth/signin"}>
      <span className={h.signInLabels}>
        <span aria-hidden={signedIn || undefined} data-hidden={signedIn || undefined}>
          Sign in
        </span>
        <span aria-hidden={!signedIn || undefined} data-hidden={!signedIn || undefined}>
          Your hub
        </span>
      </span>
    </a>
  );
}
