// Owner area. Deny by default: anyone without the allowlisted owner's session is sent to sign-in.
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth, isOwnerSession } from "@/auth";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!(await isOwnerSession(session))) redirect("/api/auth/signin");
  return <>{children}</>;
}
