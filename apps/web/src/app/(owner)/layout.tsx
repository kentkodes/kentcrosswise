// Owner area. Deny by default: anyone without the allowlisted owner's session is sent to sign-in.
// This layout check is not enough on its own: Next renders the layout and its page in parallel, so
// every page under (owner) must also call `await requireOwner()` (src/server/owner.ts) as its first
// statement, before any query. Enforced by apps/web/test/owner-pages-auth.test.ts.
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth, isOwnerSession } from "@/auth";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!(await isOwnerSession(session))) redirect("/api/auth/signin");
  return <>{children}</>;
}
