"use client";
// The mood board charts. Hand-written SVG, no chart dependency. Only the set of shown metrics is state.
// Each metric has a colour from the Paper tokens AND a dash pattern, and the legend (next to the checkboxes)
// names them, so no line relies on colour alone.
import { useId, useState } from "react";
import type { MoodKey, MoodPoint } from "../../../server/diary";
import { BOX, METRIC_DOMAIN, SENTIMENT_DOMAIN, dayLabel, metricsSummary, sentimentSummary, seriesGeometry, timeRange, yOf } from "./chart";
import m from "./mood.module.css";

const KEYS: readonly MoodKey[] = ["energy", "stress", "happiness", "satisfaction", "sadness", "anger", "anxiety", "gratitude"];
const NAMES: Record<MoodKey, string> = {
  energy: "Energy",
  stress: "Stress",
  happiness: "Happiness",
  satisfaction: "Satisfaction",
  sadness: "Sadness",
  anger: "Anger",
  anxiety: "Anxiety",
  gratitude: "Gratitude",
};
/** Four token colours, each solid and dashed. */
const STYLE: Record<MoodKey, { color: string; dash?: string }> = {
  energy: { color: "var(--ok)" },
  stress: { color: "var(--warn)" },
  happiness: { color: "var(--accent)" },
  satisfaction: { color: "var(--fg)" },
  sadness: { color: "var(--accent)", dash: "6 4" },
  anger: { color: "var(--warn)", dash: "6 4" },
  anxiety: { color: "var(--fg)", dash: "6 4" },
  gratitude: { color: "var(--ok)", dash: "6 4" },
};

function Swatch({ k }: { k: MoodKey }) {
  return (
    <svg className={m.swatch} width="28" height="10" viewBox="0 0 28 10" aria-hidden="true">
      <line x1="1" y1="5" x2="27" y2="5" stroke={STYLE[k].color} strokeWidth="2" strokeDasharray={STYLE[k].dash} />
    </svg>
  );
}

function Axes({ domain, ticks, range }: { domain: readonly [number, number]; ticks: number[]; range: { min: number; max: number } }) {
  const right = BOX.width - BOX.right;
  return (
    <g className={m.axis}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={BOX.left} x2={right} y1={yOf(t, domain)} y2={yOf(t, domain)} />
          <text x={BOX.left - 6} y={yOf(t, domain) + 4} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <text x={BOX.left} y={BOX.height - 6} textAnchor="start">
        {dayLabel(range.min)}
      </text>
      {range.max !== range.min ? (
        <text x={right} y={BOX.height - 6} textAnchor="end">
          {dayLabel(range.max)}
        </text>
      ) : null}
    </g>
  );
}

function Table({ points }: { points: readonly MoodPoint[] }) {
  return (
    <div className={m.tableWrap}>
      <table className={m.table}>
        <thead>
          <tr>
            <th scope="col">Written (UTC)</th>
            <th scope="col">Sentiment</th>
            {KEYS.map((k) => (
              <th key={k} scope="col">
                {NAMES[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <th scope="row">{p.at.slice(0, 16).replace("T", " ")}</th>
              <td>{p.sentiment.toFixed(2)}</td>
              {KEYS.map((k) => (
                <td key={k}>{p[k].toFixed(2)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MoodChart({ points }: { points: MoodPoint[] }) {
  const id = useId();
  const [shown, setShown] = useState<ReadonlySet<MoodKey>>(new Set(KEYS));
  const range = timeRange(points);
  const overall = seriesGeometry(points, "sentiment", SENTIMENT_DOMAIN, range);

  function toggle(k: MoodKey) {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  return (
    <div className={m.panels}>
      <section className={m.panel} aria-labelledby={`${id}-s`} data-testid="panel-sentiment">
        <h2 id={`${id}-s`} className={m.heading}>
          Overall sentiment
        </h2>
        <p className={m.summary} data-testid="summary-sentiment">
          {sentimentSummary(points)}
        </p>
        {range ? (
          <svg className={m.svg} viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label="Overall sentiment over time, from -1 to 1">
            <Axes domain={SENTIMENT_DOMAIN} ticks={[-1, 0, 1]} range={range} />
            <path d={overall.path} className={m.overall} />
            {overall.dots.map((d) => (
              <circle key={d.id} cx={d.x} cy={d.y} r="3" className={m.overallDot} />
            ))}
          </svg>
        ) : null}
      </section>

      <section className={m.panel} aria-labelledby={`${id}-m`} data-testid="panel-metrics">
        <h2 id={`${id}-m`} className={m.heading}>
          Metrics
        </h2>
        <fieldset className={m.toggles}>
          <legend className={m.legend}>Show metrics</legend>
          {KEYS.map((k) => (
            <label key={k} className={m.toggle}>
              <input type="checkbox" checked={shown.has(k)} onChange={() => toggle(k)} />
              <Swatch k={k} />
              <span>{NAMES[k]}</span>
            </label>
          ))}
        </fieldset>
        <p className={m.summary} data-testid="summary-metrics">
          {metricsSummary(points, KEYS, NAMES)}
        </p>
        {range ? (
          <svg className={m.svg} viewBox={`0 0 ${BOX.width} ${BOX.height}`} role="img" aria-label="Eight mood metrics over time, from 0 to 1">
            <Axes domain={METRIC_DOMAIN} ticks={[0, 0.5, 1]} range={range} />
            {KEYS.filter((k) => shown.has(k)).map((k) => {
              const g = seriesGeometry(points, k, METRIC_DOMAIN, range);
              const st = STYLE[k];
              return (
                <g key={k} data-metric={k} stroke={st.color} fill={st.color}>
                  <path d={g.path} fill="none" strokeWidth="1.75" strokeDasharray={st.dash} />
                  {g.dots.map((d) => (
                    <circle key={d.id} cx={d.x} cy={d.y} r="2" stroke="none" />
                  ))}
                </g>
              );
            })}
          </svg>
        ) : null}
      </section>

      <details className={m.panel}>
        <summary className={m.tableSummary}>Data table</summary>
        <Table points={points} />
      </details>
    </div>
  );
}
