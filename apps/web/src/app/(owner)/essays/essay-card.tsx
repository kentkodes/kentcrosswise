import Link from "next/link";
import { LENGTH_NAMES, TYPE_LABELS, readingMinutesOf, type EssayCard as Card } from "@/server/essay-library";
import type { Because } from "@/server/essay-recommend";
import styles from "./essays.module.css";

/** `because` is set on recommended cards only: the liked essay this card follows. */
export function EssayCardView({ card, because }: { card: Card; because?: Because | null }) {
  const minutes = readingMinutesOf(card);
  return (
    <article className={styles.row} data-essay-id={card.id}>
      <h3 className={styles.title}>
        <Link href={`/essays/${card.id}`}>{card.title}</Link>
      </h3>
      <p className={styles.meta}>
        {card.author}
        {card.year !== null ? <> · {card.year}</> : null}
      </p>
      <p className={styles.meta}>
        {card.primaryType ? TYPE_LABELS[card.primaryType] : "Untyped"}
        {card.kind === "link" ? (
          <>
            {" "}
            <span className={styles.badge}>Link</span>
          </>
        ) : (
          <>
            {card.lengthBand ? <> · {LENGTH_NAMES[card.lengthBand]}</> : null}
            {minutes !== null ? <> · {minutes} min read</> : null}
          </>
        )}
      </p>
      {because ? (
        <p className={styles.meta}>
          Because you liked <em>{because.title}</em> ({because.author})
        </p>
      ) : null}
      {card.hook ? <p className={styles.hook}>{card.hook}</p> : null}
    </article>
  );
}

/** A link-only essay: one line (it wraps on a phone) that opens its reader page, where the source and the rating are. */
export function LinkRowView({ card }: { card: Card }) {
  return (
    <article className={styles.linkRow} data-essay-id={card.id}>
      <Link className={styles.linkTitle} href={`/essays/${card.id}`}>
        {card.title}
      </Link>
      <span className={styles.linkMeta}>
        {card.author}
        {card.year !== null ? <> · {card.year}</> : null} · {card.primaryType ? TYPE_LABELS[card.primaryType] : "Untyped"}
      </span>
    </article>
  );
}
