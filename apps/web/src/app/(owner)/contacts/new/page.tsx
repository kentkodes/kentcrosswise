import type { Metadata } from "next";
import Link from "next/link";
import { requireOwner } from "@/server/owner";
import { OwnerFrame } from "../../owner-frame";
import { Notice, Region } from "../../owner-ui";
import { createContactAction } from "../actions";
import { ContactForm } from "../contact-form";
import { contactNotice } from "../notices";
import s from "../../owner.module.css";

export const metadata: Metadata = { title: "Add contact | Kentcrosswise" };

export default async function NewContactPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const notice = contactNotice((await searchParams).n);
  return (
    <OwnerFrame
      title="Add contact"
      current="/contacts"
      actions={
        <Link className={s.button} href="/contacts">
          All contacts
        </Link>
      }
    >
      {notice ? (
        <Notice role={notice.ok ? "status" : "alert"} tone={notice.ok ? "ok" : "warn"}>
          {notice.text}
        </Notice>
      ) : null}
      <Region>
        <ContactForm action={createContactAction} submitLabel="Add contact" />
      </Region>
    </OwnerFrame>
  );
}
