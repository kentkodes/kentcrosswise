import type { Metadata } from "next";
import Link from "next/link";
import { PublicShell } from "../../_site/public-shell";
import { OfficePreview } from "./office-preview";
import s from "./preview.module.css";
export const metadata: Metadata = { title: "Woodland studio preview | Kentcrosswise" };
export default function OfficePreviewPage() {
  return <PublicShell current="/office"><main className={s.previewMain}>
    <header className={s.heading}><h1>Woodland studio</h1><p>Sample animation preview · fictional events</p><p>Two small robots, one piece of work. Watch the handoff, or select a coworker to see what they’re doing.</p></header>
    <OfficePreview />
    <p className={s.returnLink}><Link href="/office">View real agent activity</Link> · This preview uses local samples and does not read the live feed.</p>
  </main></PublicShell>;
}
