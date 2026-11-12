import type { Metadata } from "next";
import Link from "next/link";
import { requireOwner } from "@/server/owner";
import { OwnerFrame } from "../owner-frame";
import { Region } from "../owner-ui";
import s from "../owner.module.css";

export const metadata: Metadata = { title: "Hub | Kentcrosswise" };

const PAGES = [
  { href: "/console", label: "Boss console", note: "Create tasks, follow them, pause switches" },
  { href: "/inbox", label: "Inbox", note: "Approvals waiting on you" },
  { href: "/console/usage", label: "Usage", note: "Model cost, spend cap, Actions minutes" },
  { href: "/essays", label: "Essays", note: "Library, recommendations and setup" },
] as const;

export default async function HubPage() {
  await requireOwner();
  return (
    <OwnerFrame title="Hub" current="/hub">
      <Region>
        <ul className={s.list}>
          {PAGES.map((p) => (
            <li key={p.href}>
              <Link className={s.label} href={p.href}>
                {p.label}
              </Link>
              <p className={s.note}>{p.note}</p>
            </li>
          ))}
        </ul>
      </Region>
    </OwnerFrame>
  );
}
