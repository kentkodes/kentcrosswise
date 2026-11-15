// Mood board geometry and text. Pure: no React, no "@/" imports. Two panels share one time axis, so the x
// scale is computed once over all points and each series is a polyline in a fixed SVG box.
import type { MoodKey, MoodPoint } from "../../../server/diary";

export interface Box {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const BOX: Box = { width: 640, height: 190, left: 38, right: 12, top: 10, bottom: 26 };

export const SENTIMENT_DOMAIN: readonly [number, number] = [-1, 1];
export const METRIC_DOMAIN: readonly [number, number] = [0, 1];

export interface TimeRange {
  min: number;
  max: number;
}

export function timeRange(points: readonly MoodPoint[]): TimeRange | undefined {
  if (points.length === 0) return undefined;
  const times = points.map((p) => Date.parse(p.at));
  return { min: Math.min(...times), max: Math.max(...times) };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** x in user units. A single moment (one point, or points at the same time) sits in the middle of the plot. */
export function xOf(t: number, range: TimeRange, box: Box = BOX): number {
  const w = box.width - box.left - box.right;
  if (range.max === range.min) return r1(box.left + w / 2);
  return r1(box.left + ((t - range.min) / (range.max - range.min)) * w);
}

/** y in user units: the domain's high end is at the top. */
export function yOf(v: number, domain: readonly [number, number], box: Box = BOX): number {
  const h = box.height - box.top - box.bottom;
  return r1(box.top + ((domain[1] - v) / (domain[1] - domain[0])) * h);
}

export interface Series {
  /** SVG path data: "M x y L x y ...", or "M x y" for one point. Empty for no points. */
  path: string;
  dots: { id: string; x: number; y: number }[];
}

export function seriesGeometry(
  points: readonly MoodPoint[],
  key: MoodKey | "sentiment",
  domain: readonly [number, number],
  range: TimeRange | undefined,
  box: Box = BOX,
): Series {
  if (!range) return { path: "", dots: [] };
  const dots = points.map((p) => ({ id: p.id, x: xOf(Date.parse(p.at), range, box), y: yOf(p[key], domain, box) }));
  const path = dots.map((d, i) => `${i === 0 ? "M" : "L"} ${d.x} ${d.y}`).join(" ");
  return { path, dots };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Nov 3" from UTC fields. */
export function dayLabel(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

/** The text summary of the overall sentiment panel. */
export function sentimentSummary(points: readonly MoodPoint[]): string {
  const range = timeRange(points);
  if (!range) return "No scored entries in this range.";
  const v = points.map((p) => p.sentiment);
  const avg = v.reduce((a, b) => a + b, 0) / v.length;
  const n = points.length;
  return (
    `Overall sentiment, ${n} scored ${n === 1 ? "entry" : "entries"} from ${dayLabel(range.min)} to ${dayLabel(range.max)}. ` +
    `Latest ${signed(v[v.length - 1]!)}, average ${signed(avg)}, lowest ${signed(Math.min(...v))}, highest ${signed(Math.max(...v))}.`
  );
}

/** The text summary of the metrics panel: the latest value of each metric on the 0 to 1 scale. */
export function metricsSummary(points: readonly MoodPoint[], keys: readonly MoodKey[], names: Record<MoodKey, string>): string {
  const last = points[points.length - 1];
  if (!last) return "No scored entries in this range.";
  return `Latest values from 0 to 1: ${keys.map((k) => `${names[k]} ${last[k].toFixed(2)}`).join(", ")}.`;
}

/** The start of the default range: 00:00 UTC of the day `days - 1` before today, so the range is `days` UTC days including today. */
export function rangeStart(now: Date, days: number): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - (days - 1) * 86_400_000).toISOString();
}
