// Owner allowlist: exactly one email may sign in. Pure functions, unit tested.

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** True if `email` is the owner's email (case-insensitive, surrounding whitespace ignored). */
export function isOwnerEmail(email: string | null | undefined, ownerEmail: string): boolean {
  if (typeof email !== "string" || email.trim() === "") return false;
  const owner = normalizeEmail(ownerEmail);
  if (owner === "" || !owner.includes("@")) return false;
  return normalizeEmail(email) === owner;
}

export interface SignInAttempt {
  /** Auth.js provider id, e.g. "google". */
  provider: string | undefined;
  email: string | null | undefined;
  /** Google's `email_verified` claim; ignored for the preview provider. */
  emailVerified?: unknown;
}

/**
 * The sign-in decision. Google sign-ins must carry a verified email equal to the owner's.
 * The preview provider (only present in preview builds) signs in as the preview owner.
 */
export function isAllowedSignIn(attempt: SignInAttempt, ownerEmail: string, previewProviderId?: string): boolean {
  if (attempt.provider === "google") {
    return attempt.emailVerified === true && isOwnerEmail(attempt.email, ownerEmail);
  }
  if (previewProviderId !== undefined && attempt.provider === previewProviderId) {
    return isOwnerEmail(attempt.email, ownerEmail);
  }
  return false;
}
