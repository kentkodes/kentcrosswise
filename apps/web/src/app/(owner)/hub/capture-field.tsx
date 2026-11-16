"use client";
// The capture textarea. Ctrl+Enter (Cmd+Enter on Mac) submits the surrounding form; plain Enter is a
// newline. Everything else is the plain server-action form in page.tsx, so it works without JS.
import { useEffect, useState, type KeyboardEvent } from "react";
import s from "../owner.module.css";

export function CaptureField({ maxLength }: { maxLength: number }) {
  // The browser's IANA zone travels with the capture (calendar suggestions read dates in it). Empty without JS.
  const [zone, setZone] = useState("");
  useEffect(() => {
    setZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? "");
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <>
      <input type="hidden" name="time_zone" value={zone} />
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
    </>
  );
}
