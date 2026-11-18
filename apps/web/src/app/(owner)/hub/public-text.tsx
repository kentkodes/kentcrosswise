"use client";
// The exact public text of an entry awaiting review (PL3). Each word is a button: tapping one shows "Person" and
// "Place", which add that word as a replacement (addTermAction). Placeholders such as [Person 1] are not tappable.
// Replacements can only be added, never removed. The text is rendered as text; nothing here is HTML.
import { useState } from "react";
import s from "../owner.module.css";
import { addTermAction } from "./actions";
import { pieces } from "./public-pieces";

export function PublicText({ entryId, text }: { entryId: string; text: string }) {
  const [picked, setPicked] = useState<number | null>(null);
  const parts = pieces(text);
  const word = picked === null ? null : (parts[picked]?.value ?? null);
  return (
    <div className={s.publicBox}>
      <p className={s.publicText} data-field="public-text">
        {parts.map((p, i) =>
          p.kind === "word" ? (
            <button
              key={i}
              type="button"
              className={`${s.wordButton} ${picked === i ? s.wordPicked : ""}`}
              aria-pressed={picked === i}
              onClick={() => setPicked(picked === i ? null : i)}
            >
              {p.value}
            </button>
          ) : p.kind === "placeholder" ? (
            <span key={i} className={s.placeholder}>
              {p.value}
            </span>
          ) : (
            <span key={i}>{p.value}</span>
          ),
        )}
      </p>
      {word !== null ? (
        <form action={addTermAction} className={s.formRow} data-testid="replace-word">
          <input type="hidden" name="entry_id" value={entryId} />
          <input type="hidden" name="term" value={word} />
          <span className={s.note}>
            Replace <span className={s.emph}>{word}</span> with
          </span>
          <button className={s.button} type="submit" name="kind" value="person">
            Person
          </button>
          <button className={s.button} type="submit" name="kind" value="place">
            Place
          </button>
          <button className={s.button} type="button" onClick={() => setPicked(null)}>
            Cancel
          </button>
        </form>
      ) : (
        <p className={s.note}>Tap a word to replace it.</p>
      )}
    </div>
  );
}
