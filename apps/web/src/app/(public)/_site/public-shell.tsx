// Shared page look for public pages other than home (/demo, /office): the dusk navy ground,
// Rosarivo and ivory type from DESIGN.md, and the shared header. Page content is left as it is.
import type { ReactNode } from "react";
import { rosarivo } from "./fonts";
import { SiteHeader, type PublicPath } from "./site-header";
import p from "./public-shell.module.css";

export function PublicShell({ current, children }: { current: PublicPath; children: ReactNode }) {
  return (
    <div className={`${p.shell} ${rosarivo.variable}`}>
      <SiteHeader current={current} />
      <div className={p.content}>{children}</div>
    </div>
  );
}
