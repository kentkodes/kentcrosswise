// Shared Paper frame for public pages (/ and /office): Geist, the page ground, the shared header and
// footer, and the 1120px container with the home gutters. One component, so the pages cannot drift.
import type { ReactNode } from "react";
import { geistMono, geistSans } from "./fonts";
import { SiteFooter } from "./site-footer";
import { SiteHeader, type PublicPath } from "./site-header";
import f from "./paper-frame.module.css";

export function PaperFrame({ current, children }: { current: PublicPath; children: ReactNode }) {
  return (
    <div className={`${f.page} ${geistSans.variable} ${geistMono.variable}`}>
      <SiteHeader current={current} />
      <main className={f.main}>{children}</main>
      <SiteFooter />
    </div>
  );
}
