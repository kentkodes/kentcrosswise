import {
  LENGTH_FELT,
  LENGTH_FELT_LABELS,
  WORKED_LABELS,
  WORKED_TAGS,
  type WorkedTag,
  type LengthFelt,
} from "@/server/essay-library";
import { rateAction } from "../actions";
import styles from "./reader.module.css";

const STARS = [1, 2, 3, 4, 5] as const;

// Same fields, names, values and action as before; the native inputs are hidden and their labels are drawn as pills.
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
        <div className={styles.choices}>
          {STARS.map((s) => (
            <label key={s} className={styles.pill}>
              <input
                className={styles.hidden}
                type="radio"
                name="stars"
                value={s}
                defaultChecked={rating?.stars === s}
                required
              />
              {s}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>What worked</legend>
        <div className={styles.choices}>
          {WORKED_TAGS.map((t) => (
            <label key={t} className={styles.pill}>
              <input
                className={styles.hidden}
                type="checkbox"
                name="worked"
                value={t}
                defaultChecked={rating?.worked.includes(t) ?? false}
              />
              {WORKED_LABELS[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Length felt</legend>
        <div className={styles.segmented}>
          <label className={styles.segment}>
            <input
              className={styles.hidden}
              type="radio"
              name="length_felt"
              value=""
              defaultChecked={rating === null || rating.lengthFelt === null}
            />
            Not sure
          </label>
          {LENGTH_FELT.map((l) => (
            <label key={l} className={styles.segment}>
              <input
                className={styles.hidden}
                type="radio"
                name="length_felt"
                value={l}
                defaultChecked={rating?.lengthFelt === l}
              />
              {LENGTH_FELT_LABELS[l]}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className={styles.submit}>
        {rating ? "Update rating" : "Save rating"}
      </button>
    </form>
  );
}
