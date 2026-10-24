// Soft floating lights over the meadow. A fixed, deterministic set (no randomness, so server and
// client markup match). CSS animates transform and opacity only; nothing runs in JavaScript.
import type { CSSProperties } from "react";
import s from "./home.module.css";

// x/y in % of the scenery, size in px, duration and delay in s, drift in px.
const LIGHTS: [number, number, number, number, number, number][] = [
  [6, 62, 10, 11, 0, 18],
  [14, 78, 8, 13, -4, -14],
  [22, 56, 6, 9, -2, 12],
  [29, 70, 10, 14, -7, 16],
  [35, 88, 8, 12, -3, -12],
  [42, 64, 6, 10, -6, 10],
  [47, 82, 10, 15, -9, -18],
  [55, 74, 8, 11, -1, 14],
  [61, 90, 6, 13, -5, -10],
  [68, 68, 10, 12, -8, 16],
  [74, 84, 8, 10, -2, -14],
  [81, 72, 6, 14, -10, 12],
  [87, 92, 10, 11, -4, -16],
  [93, 66, 8, 13, -6, 14],
];

export function Fireflies() {
  return (
    <div className={s.fireflies} aria-hidden="true">
      {LIGHTS.map(([x, y, size, dur, delay, drift], i) => (
        <span
          key={i}
          className={s.firefly}
          style={
            {
              left: `${x}%`,
              top: `${y}%`,
              "--size": `${size}px`,
              "--dur": `${dur}s`,
              "--delay": `${delay}s`,
              "--drift": `${drift}px`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
