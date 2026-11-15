// Mood board geometry and summaries: points, paths, scales, text.
import { describe, expect, it } from "vitest";
import type { MoodPoint } from "../src/server/diary";
import { BOX, METRIC_DOMAIN, SENTIMENT_DOMAIN, dayLabel, metricsSummary, rangeStart, sentimentSummary, seriesGeometry, timeRange, xOf, yOf } from "../src/app/(owner)/mood/chart";

const point = (id: string, at: string, o: Partial<MoodPoint> = {}): MoodPoint => ({
  id,
  at,
  energy: 0.5,
  stress: 0.5,
  happiness: 0.5,
  satisfaction: 0.5,
  sadness: 0.5,
  anger: 0.5,
  anxiety: 0.5,
  gratitude: 0.5,
  sentiment: 0,
  ...o,
});

const A = point("a", "2026-03-01T00:00:00Z", { sentiment: -1, energy: 0 });
const B = point("b", "2026-03-11T00:00:00Z", { sentiment: 0, energy: 0.5 });
const C = point("c", "2026-03-21T00:00:00Z", { sentiment: 1, energy: 1 });
const left = BOX.left;
const right = BOX.width - BOX.right;
const top = BOX.top;
const bottom = BOX.height - BOX.bottom;

describe("scales", () => {
  it("maps the first and last time to the plot edges and the middle to the middle", () => {
    const range = timeRange([A, B, C])!;
    expect(xOf(Date.parse(A.at), range)).toBe(left);
    expect(xOf(Date.parse(C.at), range)).toBe(right);
    expect(xOf(Date.parse(B.at), range)).toBe((left + right) / 2);
  });

  it("puts a single moment in the middle", () => {
    const range = timeRange([A])!;
    expect(xOf(Date.parse(A.at), range)).toBe((left + right) / 2);
  });

  it("maps the domain high end to the top and the low end to the bottom", () => {
    expect(yOf(1, SENTIMENT_DOMAIN)).toBe(top);
    expect(yOf(-1, SENTIMENT_DOMAIN)).toBe(bottom);
    expect(yOf(0, SENTIMENT_DOMAIN)).toBe((top + bottom) / 2);
    expect(yOf(0, METRIC_DOMAIN)).toBe(bottom);
    expect(yOf(1, METRIC_DOMAIN)).toBe(top);
  });

  it("has no range for no points", () => {
    expect(timeRange([])).toBeUndefined();
  });
});

describe("seriesGeometry", () => {
  it("builds one path through every point, in time order, and one dot per point", () => {
    const range = timeRange([A, B, C]);
    const g = seriesGeometry([A, B, C], "sentiment", SENTIMENT_DOMAIN, range);
    const mid = (top + bottom) / 2;
    expect(g.path).toBe(`M ${left} ${bottom} L ${(left + right) / 2} ${mid} L ${right} ${top}`);
    expect(g.dots.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(g.dots[2]).toEqual({ id: "c", x: right, y: top });
  });

  it("uses the metric domain for a metric", () => {
    const g = seriesGeometry([A, C], "energy", METRIC_DOMAIN, timeRange([A, C]));
    expect(g.path).toBe(`M ${left} ${bottom} L ${right} ${top}`);
  });

  it("draws one point as a lone move, and nothing for no points", () => {
    expect(seriesGeometry([B], "energy", METRIC_DOMAIN, timeRange([B])).path).toBe(`M ${(left + right) / 2} ${(top + bottom) / 2}`);
    expect(seriesGeometry([], "energy", METRIC_DOMAIN, undefined)).toEqual({ path: "", dots: [] });
  });

  it("shares the x scale between series, so the panels line up", () => {
    const range = timeRange([A, B, C]);
    const s = seriesGeometry([A, B, C], "sentiment", SENTIMENT_DOMAIN, range);
    const e = seriesGeometry([A, B, C], "energy", METRIC_DOMAIN, range);
    expect(s.dots.map((d) => d.x)).toEqual(e.dots.map((d) => d.x));
  });
});

describe("text", () => {
  it("labels days from UTC fields", () => {
    expect(dayLabel(Date.parse("2026-11-03T23:59:00Z"))).toBe("Nov 3");
  });

  it("summarizes the sentiment panel with count, range, latest, average, lowest and highest", () => {
    expect(sentimentSummary([A, B, C])).toBe(
      "Overall sentiment, 3 scored entries from Mar 1 to Mar 21. Latest +1.00, average 0.00, lowest -1.00, highest +1.00.",
    );
    expect(sentimentSummary([B])).toContain("1 scored entry");
    expect(sentimentSummary([])).toBe("No scored entries in this range.");
  });

  it("summarizes the latest metric values", () => {
    const names = { energy: "Energy", stress: "Stress", happiness: "Happiness", satisfaction: "Satisfaction", sadness: "Sadness", anger: "Anger", anxiety: "Anxiety", gratitude: "Gratitude" };
    expect(metricsSummary([A, C], ["energy", "stress"], names)).toBe("Latest values from 0 to 1: Energy 1.00, Stress 0.50.");
    expect(metricsSummary([], ["energy"], names)).toBe("No scored entries in this range.");
  });
});

describe("rangeStart", () => {
  it("is 00:00 UTC of the day 89 days back, the same for any time of the day", () => {
    expect(rangeStart(new Date("2026-03-31T00:00:00Z"), 90)).toBe("2026-01-01T00:00:00.000Z");
    expect(rangeStart(new Date("2026-03-31T23:59:59.999Z"), 90)).toBe("2026-01-01T00:00:00.000Z");
    expect(rangeStart(new Date("2026-04-01T00:00:00Z"), 90)).toBe("2026-01-02T00:00:00.000Z");
  });
});
