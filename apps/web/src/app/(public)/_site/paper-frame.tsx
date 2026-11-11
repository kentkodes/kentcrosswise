// Shared Paper frame for public pages (/, /demo, /office, /bot) and the owner essay reader: Geist, the page
// ground, the shared header and footer, and the 1120px container with the home gutters. One component, so the
// pages cannot drift. `current` marks a nav item; owner pages pass none. `headerBelow` renders full width inside
// the sticky header, so it stays in view with it (the reader's progress line).
import type { ReactNode } from "react";
import { geistMono, geistSans } from "./fonts";
import { SiteFooter } from "./site-footer";
import { SiteHeader, type PublicPath } from "./site-header";
import f from "./paper-frame.module.css";

export function PaperFrame({
  current,
  headerBelow,
  children,
}: {
  current?: PublicPath;
  headerBelow?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`${f.page} ${geistSans.variable} ${geistMono.variable}`}>
      <SiteHeader current={current} below={headerBelow} />
      <main className={f.main}>{children}</main>
      <SiteFooter />
    </div>
  );
}
