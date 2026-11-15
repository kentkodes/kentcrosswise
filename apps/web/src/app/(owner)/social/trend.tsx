// Followers trend: a hand-written SVG line over the account's recent days. Geometry from the shared
// sparkline (read-only); a single day shows only the end dot.
import { SPARK_H, SPARK_W, sparkline } from "@/app/(public)/_site/sparkline";
import s from "../owner.module.css";
import c from "./social.module.css";

export function Trend({ values, label }: { values: number[]; label: string }) {
  const line = sparkline(values);
  if (!line) return <span className={s.note}>none</span>;
  return (
    <svg className={c.trend} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} role="img" aria-label={`${label}: ${values.length} days`}>
      {values.length > 1 ? (
        <polyline points={line.points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      ) : null}
      <circle cx={line.end.x} cy={line.end.y} r="2.5" fill="currentColor" />
    </svg>
  );
}
