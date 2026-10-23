// The owner check for server actions. The (owner) layout guards page renders, but a server action
// is its own POST endpoint, so every owner action calls requireOwner() first: the same check as the
// layout (auth() + isOwnerSession), and the same redirect to sign-in when it fails.
import { redirect } from "next/navigation";
import { auth, isOwnerSession } from "@/auth";

export async function requireOwner(): Promise<void> {
  const session = await auth();
  if (!(await isOwnerSession(session))) redirect("/api/auth/signin");
}
