import Link from "next/link";
import { LENGTH_NAMES, TYPE_LABELS, readingMinutesOf, type EssayCard as Card } from "@/server/essay-library";
import styles from "./essays.module.css";

export function EssayCardView({ card }: { card: Card }) {
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
      {card.hook ? <p className={styles.hook}>{card.hook}</p> : null}
    </article>
  );
}
