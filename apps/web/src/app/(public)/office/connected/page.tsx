import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "../../_site/public-shell";
import { ConnectedOffice } from "./connected-office";
import s from "./connected.module.css";
export const metadata: Metadata = { title: "Connected agent office | Kentcrosswise", robots: { index: false, follow: false } };
export default function ConnectedOfficePage() {
  return <PublicShell current="/office"><main className={s.main}><header className={s.heading}><h1>The connected woodland office</h1><p>Follow recorded work through the team’s shared studio. Inspect an agent to separate current evidence from the scene being illustrated.</p></header><ConnectedOffice /><p className={s.returnLink}><Link href="/office">Agent activity</Link> · <Link href="/office/draft">Fictional composition draft</Link></p></main></PublicShell>;
}
