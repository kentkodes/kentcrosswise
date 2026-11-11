import {
  LENGTH_FELT,
  LENGTH_FELT_LABELS,
  WORKED_LABELS,
  WORKED_TAGS,
  type WorkedTag,
  type LengthFelt,
} from "@/server/essay-library";
import { rateAction } from "../actions";
import styles from "../essays.module.css";

const STARS = [1, 2, 3, 4, 5] as const;

export function RatingForm({
  essayId,
  rating,
}: {
  essayId: string;
  rating: { stars: number; worked: WorkedTag[]; lengthFelt: LengthFelt | null } | null;
}) {
  return (
    <form action={rateAction} className={styles.rating} aria-labelledby="rate-heading">
      <h2 id="rate-heading">{rating ? "Your rating" : "Rate this essay"}</h2>
      <input type="hidden" name="essay_id" value={essayId} />
      <fieldset>
        <legend>Overall</legend>
        {STARS.map((s) => (
          <label key={s}>
            <input type="radio" name="stars" value={s} defaultChecked={rating?.stars === s} required /> {s}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>What worked</legend>
        {WORKED_TAGS.map((t) => (
          <label key={t}>
            <input type="checkbox" name="worked" value={t} defaultChecked={rating?.worked.includes(t) ?? false} /> {WORKED_LABELS[t]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Length felt</legend>
        <label>
          <input type="radio" name="length_felt" value="" defaultChecked={rating === null || rating.lengthFelt === null} /> Not sure
        </label>
        {LENGTH_FELT.map((l) => (
          <label key={l}>
            <input type="radio" name="length_felt" value={l} defaultChecked={rating?.lengthFelt === l} /> {LENGTH_FELT_LABELS[l]}
          </label>
        ))}
      </fieldset>
      <button type="submit">{rating ? "Update rating" : "Save rating"}</button>
    </form>
  );
}
