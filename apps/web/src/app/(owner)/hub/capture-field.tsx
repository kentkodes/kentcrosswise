"use client";
// The capture textarea. Ctrl+Enter (Cmd+Enter on Mac) submits the surrounding form; plain Enter is a
// newline. Everything else is the plain server-action form in page.tsx, so it works without JS.
import type { KeyboardEvent } from "react";
import s from "../owner.module.css";

export function CaptureField({ maxLength }: { maxLength: number }) {
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <textarea
      id="raw_text"
      name="raw_text"
      className={`${s.field} ${s.capture}`}
      required
      maxLength={maxLength}
      rows={3}
      placeholder="A thought, a note about someone, a todo…"
      onKeyDown={onKeyDown}
    />
  );
}
