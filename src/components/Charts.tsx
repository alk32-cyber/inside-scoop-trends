"use client";
import { useId, useRef, useState } from "react";

export interface Point {
  x: number; // epoch ms
  y: number;
  label?: string;
}

/**
 * Single-series line chart: 2px line, recessive grid, crosshair + tooltip on hover/focus,
 * and a table view for screen readers and exact values. One y-axis only.
 */
export function LineChart({
  points,
  color = "var(--bar-fill)",
  height = 140,
  yMax,
  formatY = (v) => String(Math.round(v)),
  formatX = (x) => new Date(x).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
  title,
  width = 560,
}: {
  width?: number;
  points: Point[];
  color?: string;
  height?: number;
  yMax?: number;
  formatY?: (v: number) => string;
  formatX?: (x: number) => string;
  title: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const id = useId();
  if (points.length === 0) return <p className="muted">No data in this period.</p>;

  const W = width;
  const H = height;
  const pad = { l: 34, r: 8, t: 10, b: 22 };
  const xs = points.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const top = yMax ?? Math.max(1, ...points.map((p) => p.y)) * 1.1;
  const sx = (x: number) => pad.l + (x1 === x0 ? (W - pad.l - pad.r) / 2 : ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r));
  const sy = (y: number) => pad.t + (1 - y / top) * (H - pad.t - pad.b);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const ticks = [0, top / 2, top];

  const nearest = (clientX: number) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(sx(points[i].x) - px) < Math.abs(sx(points[best].x) - px)) best = i;
    return best;
  };
  const h = hover === null ? null : points[hover];

  return (
    <figure className="chart" style={{ margin: 0 }} aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="sr-only">
        {title}
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={title}
        tabIndex={0}
        onMouseMove={(e) => setHover(nearest(e.clientX))}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(points.length - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") setHover((v) => Math.max(0, (v ?? points.length - 1) - 1));
          if (e.key === "ArrowRight") setHover((v) => Math.min(points.length - 1, (v ?? 0) + 1));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={sy(t)} y2={sy(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.l - 6} y={sy(t) + 4} textAnchor="end" fontSize={10} fill="var(--text-muted)">
              {formatY(t)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 4} fontSize={10} fill="var(--text-muted)">
          {formatX(x0)}
        </text>
        <text x={W - pad.r} y={H - 4} fontSize={10} fill="var(--text-muted)" textAnchor="end">
          {formatX(x1)}
        </text>
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <g>
            <line x1={sx(h.x)} x2={sx(h.x)} y1={pad.t} y2={H - pad.b} stroke="var(--text-muted)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={sx(h.x)} cy={sy(h.y)} r={4.5} fill={color} stroke="var(--surface-1)" strokeWidth={2} />
          </g>
        )}
        {/* Hover hit area covers the whole plot, larger than the line itself. */}
        <rect x={pad.l} y={pad.t} width={W - pad.l - pad.r} height={H - pad.t - pad.b} fill="transparent" />
      </svg>
      {h && (
        <div className="tooltip tabular" style={{ left: `${(sx(h.x) / W) * 100}%`, top: `${(sy(h.y) / H) * 100}%` }}>
          {h.label ?? formatX(h.x)}: <b>{formatY(h.y)}</b>
        </div>
      )}
      <details className="table-view">
        <summary>Show as table</summary>
        <table className="data tabular">
          <thead>
            <tr>
              <th>Time (UTC)</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.x}>
                <td>{p.label ?? formatX(p.x)}</td>
                <td>{formatY(p.y)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Horizontal 0-100 bars for the score components. Missing components are labelled, never drawn as zero. */
export function ComponentBars({ components, missing }: { components: Record<string, number | null>; missing: string[] }) {
  const labels: Record<string, string> = {
    velocity: "Velocity · 30%",
    engagement: "Engagement · 25%",
    crossPlatform: "Cross-platform · 20%",
    attention: "Attention · 15%",
    relevance: "Show relevance · 10%",
  };
  return (
    <div className="bars" role="list">
      {Object.entries(labels).map(([k, label]) => {
        const v = components[k];
        return (
          <div className="bar-row" role="listitem" key={k}>
            <span className="secondary">{label}</span>
            {v === null || v === undefined || missing.includes(k) ? (
              <span className="missing">not available — reweighted</span>
            ) : (
              <div className="bar-track" aria-hidden="true">
                <div className="bar-fill" style={{ width: `${Math.max(2, v)}%` }} />
              </div>
            )}
            <span className="tabular" style={{ textAlign: "right" }}>
              {v === null || v === undefined ? "—" : Math.round(v)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Confidence({ value, level }: { value: number; level: string }) {
  return (
    <span className={`conf conf-${level}`} title="Confidence is separate from the trend score: it reflects source count, sample size, freshness, agreement and data completeness.">
      <span className="conf-dot" aria-hidden="true" />
      <span>
        {level === "high" ? "High" : level === "medium" ? "Medium" : "Low"} confidence <span className="tabular">({Math.round(value)})</span>
      </span>
    </span>
  );
}
