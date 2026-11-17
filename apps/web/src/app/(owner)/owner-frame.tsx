// Owner console frame: the shared Paper frame (PaperFrame renders the <main>), the page head with its
// heading and optional actions, and the owner nav. Owner pages render their content as children.
// Regions, dots and notices are in owner-ui.tsx.
import type { ReactNode } from "react";
import { PaperFrame } from "@/app/(public)/_site/paper-frame";
import { OwnerNav } from "./owner-nav";
import s from "./owner.module.css";

export type OwnerPath =
  | "/hub"
  | "/inbox"
  | "/contacts"
  | "/diary"
  | "/mood"
  | "/todos"
  | "/ideas"
  | "/projects"
  | "/essays"
  | "/console"
  | "/console/usage"
  | "/connections"
  | "/notifications";

const PRIMARY: { href: OwnerPath; label: string }[] = [
  { href: "/hub", label: "Hub" },
  { href: "/inbox", label: "Inbox" },
  { href: "/todos", label: "Todos" },
  { href: "/diary", label: "Diary" },
  { href: "/ideas", label: "Ideas" },
  { href: "/contacts", label: "Contacts" },
];

const MORE: { href: OwnerPath; label: string }[] = [
  { href: "/mood", label: "Mood" },
  { href: "/projects", label: "Projects" },
  { href: "/essays", label: "Essays" },
  { href: "/console", label: "Boss console" },
  { href: "/console/usage", label: "Usage" },
  { href: "/connections", label: "Connections" },
  { href: "/notifications", label: "Notifications" },
];

export function OwnerFrame({
  title,
  current,
  actions,
  children,
}: {
  title: string;
  /** The nav item for this page. Sub-pages pass their section (/essays/setup passes "/essays"). */
  current: OwnerPath;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PaperFrame>
      <div className={s.page}>
        <div className={s.top}>
          <header className={s.head}>
            <h1 className={s.title}>{title}</h1>
            {actions ? <div className={s.actions}>{actions}</div> : null}
          </header>
          <OwnerNav primary={PRIMARY} more={MORE} current={current} />
        </div>
        {children}
      </div>
    </PaperFrame>
  );
}
