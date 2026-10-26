import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "../../_site/public-shell";
import { OfficeDraft } from "./office-draft";
import s from "./draft.module.css";

export const metadata: Metadata = { title: "Connected woodland office draft | Kentcrosswise", robots: { index: false, follow: false } };
export default function OfficeDraftPage() {
  return <PublicShell current="/office"><main className={s.main}>
    <header className={s.heading}><h1>A room for the whole team</h1><p className={s.sample}>Local composition draft · fictional activity</p><p>One shared studio, separate pieces of work. Select a coworker to follow their task, or watch the packets move through the room.</p></header>
    <OfficeDraft />
    <p className={s.returnLink}><Link href="/office">Real agent activity</Link> · <Link href="/office/preview">Two-robot sample</Link></p>
  </main></PublicShell>;
}
