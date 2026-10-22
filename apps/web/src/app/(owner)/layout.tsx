// Owner area. Deny by default: until Auth.js lands (P1-07), every owner route redirects home.
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default function OwnerLayout({ children }: { children: ReactNode }) {
  const signedIn = false; // P1-07: replace with the Auth.js session check.
  if (!signedIn) redirect("/");
  return <>{children}</>;
}
