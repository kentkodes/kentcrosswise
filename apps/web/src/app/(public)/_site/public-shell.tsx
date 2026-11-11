// Shared page look for public pages other than home (/demo, /office, /bot): the dusk navy ground,
// Rosarivo and ivory type from DESIGN.md, the shared header and footer. Page content is left as it is.
import type { ReactNode } from "react";
import { geistMono, geistSans, rosarivo } from "./fonts";
import { SiteFooter } from "./site-footer";
import { SiteHeader, type PublicPath } from "./site-header";
import p from "./public-shell.module.css";

export function PublicShell({ current, children }: { current: PublicPath; children: ReactNode }) {
  return (
    <div className={`${p.shell} ${rosarivo.variable} ${geistSans.variable} ${geistMono.variable}`}>
      <SiteHeader current={current} />
      <div className={p.content}>{children}</div>
      <SiteFooter />
    </div>
  );
}
