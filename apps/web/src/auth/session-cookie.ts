// Auth.js session cookie names, plain or `__Secure-` prefixed, whole or chunked (`.0`, `.1`, ...).
const SESSION_COOKIE = /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/;

/** True if any of the cookie names is an Auth.js session cookie. Pure, unit tested. */
export function hasSessionCookie(names: Iterable<string>): boolean {
  for (const name of names) if (SESSION_COOKIE.test(name)) return true;
  return false;
}
