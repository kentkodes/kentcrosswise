// Read-only session check for the public navigation ("Sign in" vs "Your hub"). It never signs in,
// out or redirects. Visitors without an Auth.js session cookie are answered without loading the
// auth settings, so anonymous page views never read Secrets Manager.
import { cookies } from "next/headers";
import { auth } from "./index";
import { hasSessionCookie } from "./session-cookie";

/** True if the visitor has a valid session. Any auth failure counts as signed out. */
export async function isSignedIn(): Promise<boolean> {
  const jar = await cookies();
  if (!hasSessionCookie(jar.getAll().map((c) => c.name))) return false;
  try {
    const session = await auth();
    return !!session?.user;
  } catch {
    return false;
  }
}
