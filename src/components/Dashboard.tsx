"use client";
import { useCallback, useEffect, useState } from "react";
import { ComponentBars, Confidence, LineChart } from "./Charts";
import { ago, compact, FLAG_LABEL, LIFECYCLE_ICON, LIFECYCLE_LABEL, SOURCE_LABEL, SOURCE_UNIT, utc } from "./format";

interface Trend {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  trendScore: number;
  scoreChange24h: number | null;
  lifecycle: string;
  lifecycleReason: string | null;
  confidence: number;
  confidenceLevel: string;
  highScoreLowConfidence: boolean;
  sourceCount: number;
  sources: string[];
  components: Record<string, number | null>;
  missingComponents: string[];
  flags: string[];
  opportunityScore: number;
  explanation: string | null;
  explanationIsAnalysis: boolean;
  topAngle: { title: string; format: string; angle: string } | null;
  analysisMethod: "llm" | "template" | null;
  lastUpdated: string;
  dataAsOf: string | null;
  stale: boolean;
  isDemo: boolean;
}
interface TrendsResponse {
  mode: "live" | "demo";
  total: number;
  limit: number;
  offset: number;
  items: Trend[];
}
interface Status {
  mode: string;
  providers: Array<{ provider: string; label: string; connection: string; stale: boolean; lastSuccessAt: string | null; lastError: { message: string | null; at: string } | null }>;
  scoring: { topicsScored: number; lastScoredAt: string | null };
}

const VIEWS: Array<{ id: string; label: string; hint: string }> = [
  { id: "all", label: "All trending", hint: "Every active topic, ranked by trend score." },
  { id: "opportunities", label: "Best for Inside Scoop", hint: "Trend score (60%) + show relevance (25%) + confidence (15%), medium confidence or better." },
  { id: "emerging", label: "Emerging", hint: "Newly detected topics growing from a low or near-zero baseline." },
  { id: "breakout", label: "Breakout", hint: "At least 3× their own baseline, confirmed by two or more independent sources." },
  { id: "momentum", label: "Gaining momentum", hint: "Growing topics ordered by how much their score rose in the last 24 hours." },
  { id: "most_discussed", label: "Most discussed", hint: "Highest current attention relative to other topics on the same platform, regardless of growth." },
  { id: "cooling", label: "Cooling down", hint: "Peaking or declining topics, steepest decline first." },
];

const CATEGORIES = [
  ["", "All categories"],
  ["entrepreneurship", "Entrepreneurship"],
  ["startups", "Startups"],
  ["business_strategy", "Business strategy"],
  ["technology", "Technology"],
  ["marketing", "Marketing"],
  ["finance_education", "Finance education"],
  ["leadership", "Leadership"],
  ["negotiation", "Negotiation"],
  ["genz_culture", "Gen Z culture"],
  ["other", "Other"],
];
const LIFECYCLES = ["", "emerging", "rising", "breakout", "peaking", "stable", "cooling", "dormant", "insufficient_data"];

const PAGE = 20;

function readUrl() {
  if (typeof window === "undefined") return {} as Record<string, string>;
  return Object.fromEntries(new URLSearchParams(window.location.search).entries());
}

export function Dashboard() {
  const [filters, setFilters] = useState<Record<string, string>>({ view: "all", category: "", source: "", window: "", lifecycle: "", minConfidence: "0" });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<TrendsResponse | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const u = readUrl();
    setFilters((f) => ({ ...f, ...Object.fromEntries(Object.entries(u).filter(([k]) => k in f)) }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    for (const [k, v] of Object.entries(filters)) if (v && !(k === "minConfidence" && v === "0") && !(k === "view" && v === "all")) params.set(k, v);
    if (filters.view !== "all") params.set("view", filters.view);
    window.history.replaceState(null, "", `?${new URLSearchParams(Object.entries(filters).filter(([k, v]) => v && v !== "0" && !(k === "view" && v === "all")))}`);
    try {
      const [t, s] = await Promise.all([fetch(`/api/trends?${params}`), fetch("/api/system/status")]);
      if (!t.ok) throw new Error((await t.json().catch(() => null))?.error?.message ?? `HTTP ${t.status}`);
      setData(await t.json());
      if (s.ok) setStatus(await s.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filters, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const set = (k: string, v: string) => {
    setOffset(0);
    setFilters((f) => ({ ...f, [k]: v }));
  };
  const view = VIEWS.find((v) => v.id === filters.view) ?? VIEWS[0];
  const staleProviders = status?.providers.filter((p) => p.connection === "connected" && p.stale) ?? [];
  const failing = status?.providers.filter((p) => p.connection === "failing") ?? [];
  const anyConnected = status?.providers.some((p) => p.connection === "connected" || p.connection === "demo");

  return (
    <main>
      {data?.mode === "demo" && (
        <div className="banner demo" role="note">
          <span aria-hidden="true">🧪</span>
          <span>
            <strong>Demo data.</strong> Every topic, metric and link on this page is simulated (DEMO_MODE=true) so you can see how the algorithm behaves. Nothing here reflects real
            trends; the simulated timeline is re-anchored to the current time. Set <code>DEMO_MODE=false</code> to show live data only.
          </span>
        </div>
      )}
      {data?.mode === "live" && staleProviders.length > 0 && (
        <div className="banner stale" role="status">
          <span aria-hidden="true">⚠</span>
          <span>
            <strong>Some data is stale.</strong> {staleProviders.map((p) => `${p.label} last updated ${ago(p.lastSuccessAt)}`).join("; ")}. Scores below use the last successful
            collection and are not live. <a href="/status">System status</a>
          </span>
        </div>
      )}
      {data?.mode === "live" && failing.length > 0 && (
        <div className="banner error" role="status">
          <span aria-hidden="true">✕</span>
          <span>
            <strong>Provider errors:</strong> {failing.map((p) => p.label).join(", ")}. Other sources keep working. <a href="/status">Details</a>
          </span>
        </div>
      )}

      <div className="tabs" role="tablist" aria-label="Views">
        {VIEWS.map((v) => (
          <button key={v.id} role="tab" className="tab" aria-selected={filters.view === v.id} onClick={() => set("view", v.id)}>
            {v.label}
          </button>
        ))}
      </div>
      <p className="view-hint">{view.hint}</p>

      <div className="filters" role="group" aria-label="Filters">
        <label>
          Category
          <select value={filters.category} onChange={(e) => set("category", e.target.value)}>
            {CATEGORIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Platform
          <select value={filters.source} onChange={(e) => set("source", e.target.value)}>
            <option value="">All platforms</option>
            {Object.entries(SOURCE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          Seen in
          <select value={filters.window} onChange={(e) => set("window", e.target.value)}>
            <option value="">Any time</option>
            <option value="24h">Last 24 hours</option>
            <option value="72h">Last 3 days</option>
            <option value="7d">Last 7 days</option>
          </select>
        </label>
        <label>
          Lifecycle
          <select value={filters.lifecycle} onChange={(e) => set("lifecycle", e.target.value)} disabled={["emerging", "breakout", "cooling"].includes(filters.view)}>
            {LIFECYCLES.map((l) => (
              <option key={l} value={l}>
                {l ? LIFECYCLE_LABEL[l] : "Any stage"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Min. confidence
          <select value={filters.minConfidence} onChange={(e) => set("minConfidence", e.target.value)}>
            <option value="0">Any</option>
            <option value="40">Medium+ (40)</option>
            <option value="70">High (70)</option>
          </select>
        </label>
        <button className="reset" onClick={() => setFilters({ view: filters.view, category: "", source: "", window: "", lifecycle: "", minConfidence: "0" })}>
          Reset filters
        </button>
      </div>

      {error && (
        <div className="banner error" role="alert">
          <span aria-hidden="true">✕</span>
          <span>
            <strong>Could not load trends.</strong> {error}{" "}
            <button className="reset" onClick={load}>
              Retry
            </button>
          </span>
        </div>
      )}

      {loading && !data && (
        <div className="list" aria-busy="true" aria-label="Loading trends">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" />
          ))}
        </div>
      )}

      {data && data.items.length === 0 && !error && (
        <div className="card empty">
          {status && status.scoring.topicsScored === 0 ? (
            <>
              <h3>No trend data yet</h3>
              <p className="secondary">
                {anyConnected
                  ? "Providers are connected but no topics have enough observations to score yet. Scores appear after a few collection runs."
                  : "No provider has completed a successful collection. Add credentials (see README → Provider setup), then run "}
                {!anyConnected && <code>npm run ingest</code>}
                {!anyConnected && (
                  <>
                    {" "}
                    — or preview the dashboard with simulated data: <code>npm run demo:seed</code> and <code>DEMO_MODE=true</code>.
                  </>
                )}
              </p>
              <p>
                <a href="/status">Check system status</a>
              </p>
            </>
          ) : (
            <>
              <h3>No topics match these filters</h3>
              <p className="secondary">Try a different view, a wider time window, or a lower minimum confidence.</p>
            </>
          )}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="list" aria-busy={loading}>
          {data.items.map((t, i) => (
            <TrendCard key={t.id} t={t} rank={data.offset + i + 1} showOpportunity={filters.view === "opportunities"} />
          ))}
        </div>
      )}

      {data && data.total > PAGE && (
        <div className="pager">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            ← Previous
          </button>
          <span className="muted tabular">
            {data.offset + 1}–{Math.min(data.total, data.offset + PAGE)} of {data.total}
          </span>
          <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
            Next →
          </button>
        </div>
      )}
      {status?.scoring.lastScoredAt && (
        <p className="footer">
          Last scored {utc(status.scoring.lastScoredAt)} ({ago(status.scoring.lastScoredAt)}).
        </p>
      )}
    </main>
  );
}

function TrendCard({ t, rank, showOpportunity }: { t: Trend; rank: number; showOpportunity: boolean }) {
  const [open, setOpen] = useState(false);
  const delta = t.scoreChange24h;
  const visibleFlags = t.flags.filter((f) => FLAG_LABEL[f] && f !== "partial_components" && f !== "low_confidence");
  return (
    <article className="card">
      <div className="trend">
        <div className="rank tabular">#{rank}</div>
        <div>
          <div className="trend-title">
            <h3>
              <a href={`/topics/${t.id}`}>{t.name}</a>
            </h3>
            <span className="chip" title={t.lifecycleReason ?? undefined}>
              <span aria-hidden="true">{LIFECYCLE_ICON[t.lifecycle]}</span> {LIFECYCLE_LABEL[t.lifecycle] ?? t.lifecycle}
            </span>
            {t.isDemo && <span className="chip demo">Demo</span>}
            {visibleFlags.map((f) => (
              <span key={f} className="chip flag">
                {FLAG_LABEL[f]}
              </span>
            ))}
          </div>
          <div className="meta">
            <span>{t.categoryLabel}</span>
            <Confidence value={t.confidence} level={t.confidenceLevel} />
            <span>
              {t.sourceCount} {t.sourceCount === 1 ? "source" : "sources"}
              {t.sources.length ? ` (${t.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")})` : ""}
            </span>
            <span title={`Scored ${utc(t.lastUpdated)}; newest data collected ${utc(t.dataAsOf)}`}>
              Updated {ago(t.lastUpdated)}
              {t.stale ? " · data stale" : ""}
            </span>
          </div>
          {t.explanation && (
            <p className="why">
              {t.explanationIsAnalysis ? "" : <span className="muted">Measured: </span>}
              {t.explanation}
            </p>
          )}
          {t.topAngle && (
            <p className="angle">
              <b>Episode angle{t.analysisMethod === "template" ? " (template)" : ""}:</b> {t.topAngle.title} — <span className="secondary">{t.topAngle.angle}</span>
            </p>
          )}
        </div>
        <div className="score">
          <div className="score-value tabular" aria-label={`Trend score ${t.trendScore} out of 100`}>
            {Math.round(t.trendScore)}
            <small>/100</small>
          </div>
          <div className={`delta tabular ${delta === null ? "muted" : delta > 0 ? "up" : delta < 0 ? "down" : "muted"}`}>
            {delta === null ? "no 24h history" : `${delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} ${Math.abs(delta).toFixed(1)} in 24h`}
          </div>
          {showOpportunity && <div className="muted tabular" style={{ fontSize: 12, marginTop: 4 }}>Opportunity {Math.round(t.opportunityScore)}</div>}
        </div>
      </div>
      <details className="expand" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Score breakdown, history and evidence</summary>
        {open && <TrendExpanded t={t} />}
      </details>
    </article>
  );
}

interface Detail {
  history: Array<{ asOf: string; trendScore: number; confidence: number }>;
  activity: Array<{ source: string; windowEnd: string; metric: string; value: number | null }>;
  evidence: Array<{ id: number; provider: string; title: string; url: string; author: string | null; publishedAt: string | null; isDemo: boolean }>;
  breakdown: { confidenceParts?: Record<string, number>; coverage?: number; independentSources?: number; uniqueStories?: number; totalSample?: number };
}

function TrendExpanded({ t }: { t: Trend }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/trends/${t.id}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setD)
      .catch((e) => setErr(e.message));
  }, [t.id]);

  return (
    <div className="expand-body">
      <div className="grid-2">
        <section>
          <h4 className="section-title">Score components (0–100)</h4>
          <ComponentBars components={t.components} missing={t.missingComponents} />
          {t.missingComponents.length > 0 && (
            <p className="muted" style={{ fontSize: 12 }}>
              Unavailable components are excluded and the remaining weights rescaled; confidence is reduced accordingly.
            </p>
          )}
          {t.highScoreLowConfidence && (
            <p className="banner stale" style={{ margin: "8px 0 0" }}>
              ⚠ High score but low confidence: treat as a lead to verify, not a confirmed trend.
            </p>
          )}
        </section>
        <section>
          <h4 className="section-title">Trend score history</h4>
          {err && <p className="muted">Could not load history ({err}).</p>}
          {!d && !err && <div className="skeleton" style={{ height: 120 }} />}
          {d && d.history.length < 2 && <p className="muted">Not enough score history yet — a trajectory appears after a few scoring runs.</p>}
          {d && d.history.length >= 2 && (
            <LineChart
              title={`Trend score history for ${t.name}`}
              yMax={100}
              points={d.history.map((h) => ({ x: Date.parse(h.asOf), y: h.trendScore, label: utc(h.asOf) }))}
              formatY={(v) => String(Math.round(v))}
            />
          )}
        </section>
      </div>
      {d && d.activity.length > 0 && (
        <section>
          <h4 className="section-title">Measured activity by platform (rolling 24h windows)</h4>
          <ActivityMultiples activity={d.activity} />
        </section>
      )}
      {d && (
        <section>
          <h4 className="section-title">Original evidence</h4>
          <EvidenceList items={d.evidence} />
          <p style={{ fontSize: 13 }}>
            <a href={`/topics/${t.id}`}>Full analysis, content ideas and all sources →</a>
          </p>
        </section>
      )}
    </div>
  );
}

export function ActivityMultiples({ activity }: { activity: Detail["activity"] }) {
  const bySource = new Map<string, Detail["activity"]>();
  for (const a of activity) bySource.set(a.source, [...(bySource.get(a.source) ?? []), a]);
  const order = ["youtube", "reddit", "news", "google_trends"];
  return (
    <div className="small-multiples">
      {[...bySource.entries()]
        .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
        .map(([source, rows]) => (
          <div className="mini" key={source}>
            <h5>{SOURCE_LABEL[source] ?? source}</h5>
            <div className="unit">{SOURCE_UNIT[rows[0].metric] ?? rows[0].metric}</div>
            <LineChart
              title={`${SOURCE_LABEL[source] ?? source}: ${SOURCE_UNIT[rows[0].metric] ?? rows[0].metric}`}
              color={`var(--series-${source})`}
              width={260}
              height={120}
              yMax={rows[0].metric === "search_interest" ? 100 : undefined}
              points={rows.map((r) => ({ x: Date.parse(r.windowEnd), y: r.value ?? 0, label: `24h to ${utc(r.windowEnd)}` }))}
              formatY={(v) => compact(v)}
            />
          </div>
        ))}
    </div>
  );
}

export function EvidenceList({ items }: { items: Detail["evidence"] }) {
  if (items.length === 0) return <p className="muted">No linked evidence yet.</p>;
  return (
    <ul className="evidence">
      {items.map((e) => (
        <li key={e.id}>
          <span className="src">{SOURCE_LABEL[e.provider] ?? e.provider}</span>
          <span>
            <a href={e.url} target="_blank" rel="noopener noreferrer nofollow">
              {e.title}
            </a>
            <span className="sub">
              {e.author ? `${e.author} · ` : ""}
              {e.publishedAt ? utc(e.publishedAt) : "publication time not supplied"}
              {e.isDemo ? " · simulated" : ""}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
