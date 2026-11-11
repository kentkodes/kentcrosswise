// The owner check for the (owner) area: the layout, every (owner) page and every server action.
// Pages must call `await requireOwner()` as their FIRST statement, before any query or data access.
// Why: the layout's redirect does not stop the page from rendering. Next renders a layout and its
// page in parallel, so a page without this check still runs its database queries for a visitor, and
// the rendered data is streamed in the body of the redirect response. This call makes the page's
// own check run before anything else. A server action is its own POST endpoint, so actions call it too.
// Same check as the layout (auth() + isOwnerSession) and the same redirect to sign-in when it fails.
import { redirect } from "next/navigation";
import { auth, isOwnerSession } from "@/auth";

export async function requireOwner(): Promise<void> {
  const session = await auth();
  if (!(await isOwnerSession(session))) redirect("/api/auth/signin");
}
