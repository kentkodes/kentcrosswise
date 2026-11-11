// Sparkline geometry shared by the home product still and the /demo Today card. Pure: no React.

// Sparkline in user units, drawn 1:1 at its CSS size so the endpoint dot stays round.
export const SPARK_W = 160;
export const SPARK_H = 36;
const PAD_X = 4;

// Scales the week's values to their own min and max, with 15% of the height left empty at top and
// bottom. If every value is equal, the line is drawn flat through the middle.
export function sparkline(values: number[]) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const top = SPARK_H * 0.15;
  const bottom = SPARK_H * 0.85;
  const step = values.length > 1 ? (SPARK_W - 2 * PAD_X) / (values.length - 1) : 0;
  const pts = values.map((v, i) => ({
    x: PAD_X + i * step,
    y: hi === lo ? SPARK_H / 2 : bottom - ((v - lo) / (hi - lo)) * (bottom - top),
  }));
  const end = pts.at(-1);
  if (!end) return undefined;
  return { points: pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "), end };
}
