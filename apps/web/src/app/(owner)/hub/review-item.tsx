// One entry awaiting review (PL3): the private text, the route, the exact public text (or why it is withheld),
// "Correct", and the shared "Change route" picker. Correct and a reassignment are the owner's verdict on the route.
import { ROUTE_LABELS } from "@/server/capture";
import type { WithheldItem } from "@/server/publish";
import type { ReviewItem as Item, WithheldReason } from "@/server/review";
import { formatUtc } from "../format";
import s from "../owner.module.css";
import { confirmAction, findNamesAction } from "./actions";
import { ChangeRoute } from "./entry-row";
import { PublicText } from "./public-text";

const WITHHELD: Readonly<Record<WithheldReason, string>> = {
  cap: "Name check paused: monthly spend cap reached.",
  "too-long": "Too long to check for names, so it stays private.",
  failed: "The name check failed.",
  invalid: "The name check gave an unusable answer.",
  timeout: "The name check timed out.",
  "private-other": "About another person's private matters, so it stays private.",
  control: "Contains control characters, so it stays private.",
  mixed_script: "Mixes look-alike alphabets in a word, so it stays private.",
  blocklist: "Contains a blocked term, so it stays private.",
  recheck: "Could not be fully sanitized, so it stays private.",
  error: "Could not be sanitized, so it stays private.",
};

/** Withheld reasons that a new name check can change. */
const RETRY: ReadonlySet<WithheldReason> = new Set(["cap", "failed", "invalid", "timeout"]);

export function ReviewEntry({ e, routing }: { e: Item; routing: boolean }) {
  const p = e.preview;
  return (
    <li data-entry-id={e.id}>
      <p className={s.entryText}>{e.rawText}</p>
      <p className={s.entryMeta}>
        <time className={s.mono} dateTime={e.createdAt}>
          {formatUtc(e.createdAt)}
        </time>
        <span data-field="route" className={s.emph}>
          {ROUTE_LABELS[e.routeKind]}
        </span>
      </p>
      {p.state === "ready" ? (
        <PublicText entryId={e.id} text={p.text} />
      ) : (
        <div className={`${s.publicBox} ${s.formRow}`}>
          <p className={s.note} data-field="public-text">
            {p.state === "pending" ? "Names not checked yet." : WITHHELD[p.reason]}
          </p>
          {routing && (p.state === "pending" || RETRY.has(p.reason)) ? (
            <form action={findNamesAction}>
              <input type="hidden" name="entry_id" value={e.id} />
              <button className={s.button} type="submit">
                Find names again
              </button>
            </form>
          ) : null}
        </div>
      )}
      <div className={s.formRow}>
        <form action={confirmAction}>
          <input type="hidden" name="entry_id" value={e.id} />
          <button className={s.button} type="submit">
            Correct
          </button>
        </form>
      </div>
      <ChangeRoute e={e} routing={routing} />
    </li>
  );
}

/** A reviewed entry withheld from the public log because its name check did not succeed (PL4). A new check that
 *  succeeds publishes it (findNamesAction). */
export function WithheldEntry({ e, routing }: { e: WithheldItem; routing: boolean }) {
  const label = e.reason === "pending" ? "Names not checked yet." : (WITHHELD[e.reason as WithheldReason] ?? "Withheld.");
  return (
    <li data-entry-id={e.id}>
      <p className={s.entryText}>{e.rawText}</p>
      <div className={`${s.publicBox} ${s.formRow}`}>
        <p className={s.note} data-field="withheld">
          Withheld from the public log. {label}
        </p>
        {routing ? (
          <form action={findNamesAction}>
            <input type="hidden" name="entry_id" value={e.id} />
            <button className={s.button} type="submit">
              Find names again
            </button>
          </form>
        ) : null}
      </div>
    </li>
  );
}
