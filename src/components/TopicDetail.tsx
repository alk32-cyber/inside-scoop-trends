"use client";
import { useEffect, useState } from "react";
import { ComponentBars, Confidence, LineChart } from "./Charts";
import { ActivityMultiples, EvidenceList } from "./Dashboard";
import { ago, FLAG_LABEL, LIFECYCLE_ICON, LIFECYCLE_LABEL, SOURCE_LABEL, utc } from "./format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export function TopicDetail({ id }: { id: string }) {
  const [d, setD] = useState<Any>(null);
  const [ideas, setIdeas] = useState<Any>(null);
  const [sources, setSources] = useState<Any>(null);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetch(`/api/trends/${id}`), fetch(`/api/trends/${id}/content-ideas`)])
      .then(async ([a, b]) => {
        if (a.status === 404) throw new Error("This topic has not been scored (or belongs to the other data mode).");
        if (!a.ok) throw new Error(`HTTP ${a.status}`);
        setD(await a.json());
        if (b.ok) setIdeas(await b.json());
      })
      .catch((e) => setErr(e.message));
  }, [id]);
  useEffect(() => {
    fetch(`/api/trends/${id}/sources?limit=25&offset=${offset}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setSources)
      .catch(() => setSources(null));
  }, [id, offset]);

  if (err)
    return (
      <div className="banner error" role="alert">
        ✕ <span>{err} <a href="/">Back to trends</a></span>
      </div>
    );
  if (!d)
    return (
      <div className="page" aria-busy="true">
        <div className="skeleton" style={{ height: 80 }} />
        <div className="skeleton" style={{ height: 220 }} />
      </div>
    );

  const t = d.topic;
  const a = ideas?.analysis ?? d.analysis;
  const parts = d.breakdown?.confidenceParts ?? {};
  return (
    <main className="page">
      {t.isDemo && (
        <div className="banner demo" role="note">
          🧪 <span><strong>Demo data.</strong> This topic, its metrics and its links are simulated.</span>
        </div>
      )}
      <div>
        <a href="/" className="muted" style={{ fontSize: 14 }}>← All trends</a>
        <h1>{t.name}</h1>
        <div className="meta" style={{ fontSize: 14 }}>
          <span className="chip"><span aria-hidden="true">{LIFECYCLE_ICON[t.lifecycle]}</span> {LIFECYCLE_LABEL[t.lifecycle]}</span>
          <span>{t.categoryLabel}</span>
          <span className="tabular"><b>{Math.round(t.trendScore)}</b>/100 trend score</span>
          <span className="tabular">{t.scoreChange24h === null ? "no 24h history" : `${t.scoreChange24h > 0 ? "▲" : t.scoreChange24h < 0 ? "▼" : "•"} ${Math.abs(t.scoreChange24h).toFixed(1)} in 24h`}</span>
          <Confidence value={t.confidence} level={t.confidenceLevel} />
          <span>{t.sources.map((s: string) => SOURCE_LABEL[s] ?? s).join(", ")}</span>
          <span>Scored {utc(t.lastUpdated)} · data collected {utc(t.dataAsOf)}{t.stale ? " (stale)" : ""}</span>
        </div>
        {t.flags.filter((f: string) => FLAG_LABEL[f]).length > 0 && (
          <div className="meta">{t.flags.filter((f: string) => FLAG_LABEL[f]).map((f: string) => <span className="chip flag" key={f}>{FLAG_LABEL[f]}</span>)}</div>
        )}
        {t.lifecycleReason && <p className="secondary" style={{ margin: "8px 0 0" }}>{t.lifecycleReason}</p>}
      </div>

      {a && (
        <section className="card panel">
          <h2 className="section-title">Why it&apos;s trending</h2>
          <p style={{ marginTop: 0 }}>{a.description}</p>
          <p><b>{a.evidence_sufficient ? "Evidence-based explanation:" : "Status:"}</b> {a.why_rising}</p>
          {a.strongest_signals?.length > 0 && (
            <>
              <h3 className="section-title">Strongest measured signals</h3>
              <ul className="facts">{a.strongest_signals.map((s: Any, i: number) => <li key={i}>{s.signal}</li>)}</ul>
            </>
          )}
          {a.confirmed_facts?.length > 0 && (
            <>
              <h3 className="section-title" style={{ marginTop: 14 }}>Confirmed from sources</h3>
              <ul className="facts">
                {a.confirmed_facts.map((f: Any, i: number) => (
                  <li key={i}>
                    {f.statement}{" "}
                    {f.evidence_urls.map((u: string, j: number) => (
                      <a key={u} href={u} target="_blank" rel="noopener noreferrer nofollow" style={{ fontSize: 12 }}>[{j + 1}]</a>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}
          {a.recent_developments && <p className="secondary"><b>Recent developments:</b> {a.recent_developments}</p>}
          {a.potential_explanations?.length > 0 && (
            <>
              <h3 className="section-title" style={{ marginTop: 14 }}>Possible explanations — not confirmed</h3>
              <ul className="facts">{a.potential_explanations.map((p: Any, i: number) => <li key={i}>{p.hypothesis} <span className="muted">(would be confirmed by: {p.what_would_confirm_it})</span></li>)}</ul>
            </>
          )}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {a.method === "llm" ? `Summarized by ${a.model} from the linked evidence only.` : "Template summary built from measured metrics (no language model)."} Based on data up to {utc(a.data_timestamp)}.
            {a.validation?.unverified_numbers?.length ? ` ⚠ Numbers not found in the evidence: ${a.validation.unverified_numbers.join(", ")}.` : ""}
          </p>
        </section>
      )}

      {a?.content_angles?.length > 0 && (
        <section className="card panel">
          <h2 className="section-title">Inside Scoop content angles{a.method === "template" ? " (template — add ANTHROPIC_API_KEY for evidence-based angles)" : ""}</h2>
          <div className="angles">
            {a.content_angles.map((c: Any, i: number) => (
              <div className="angle-card" key={i}>
                <div className="fmt">{c.format}</div>
                <h4>{c.title}</h4>
                <div className="secondary" style={{ fontSize: 14 }}>{c.angle}</div>
              </div>
            ))}
          </div>
          <div className="grid-2" style={{ marginTop: 14 }}>
            <div>
              <h3 className="section-title">Interview questions</h3>
              <ul className="facts">{a.interview_questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>
            </div>
            <div>
              <h3 className="section-title">Business case-study questions</h3>
              <ul className="facts">{a.case_study_questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>
            </div>
          </div>
        </section>
      )}

      <section className="card panel grid-2">
        <div>
          <h2 className="section-title">Score breakdown</h2>
          <ComponentBars components={t.components} missing={t.missingComponents} />
          <h3 className="section-title" style={{ marginTop: 14 }}>Confidence inputs (0–1)</h3>
          <dl className="kv tabular">
            <dt>Independent sources</dt><dd>{parts.sources?.toFixed(2) ?? "—"}</dd>
            <dt>Sample size</dt><dd>{parts.sample?.toFixed(2) ?? "—"} ({d.breakdown.totalSample} items/points)</dd>
            <dt>Freshness</dt><dd>{parts.freshness?.toFixed(2) ?? "—"}</dd>
            <dt>Cross-source agreement</dt><dd>{parts.consistency?.toFixed(2) ?? "—"}</dd>
            <dt>Completeness</dt><dd>{parts.completeness?.toFixed(2) ?? "—"}</dd>
          </dl>
        </div>
        <div>
          <h2 className="section-title">Trend score history</h2>
          {d.history.length >= 2 ? (
            <LineChart title={`Trend score history for ${t.name}`} yMax={100} points={d.history.map((h: Any) => ({ x: Date.parse(h.asOf), y: h.trendScore, label: utc(h.asOf) }))} />
          ) : (
            <p className="muted">Not enough score history yet.</p>
          )}
          {d.breakdown.perSource && (
            <table className="data tabular" style={{ marginTop: 10 }}>
              <thead><tr><th>Source</th><th>Recent</th><th>Baseline avg</th><th>Growth</th><th>Sample</th></tr></thead>
              <tbody>
                {d.breakdown.perSource.map((s: Any) => (
                  <tr key={s.source}>
                    <td>{SOURCE_LABEL[s.source.replace(/^demo_/, "")] ?? s.source}</td>
                    <td>{s.recent === null ? "—" : Math.round(s.recent).toLocaleString()}</td>
                    <td>{s.baseline === null ? "—" : Math.round(s.baseline).toLocaleString()}</td>
                    <td>{s.logGrowth === null ? <span className="muted">{(s.velocityUnavailableReason ?? "").replace(/_/g, " ")}</span> : `${Math.round((Math.exp(s.logGrowth) - 1) * 100)}%`}</td>
                    <td>{s.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {d.activity.length > 0 && (
        <section className="card panel">
          <h2 className="section-title">Measured activity by platform</h2>
          <ActivityMultiples activity={d.activity} />
        </section>
      )}

      <section className="card panel">
        <h2 className="section-title">All supporting sources {sources ? `(${sources.total})` : ""}</h2>
        {sources ? <EvidenceList items={sources.items} /> : <div className="skeleton" style={{ height: 100 }} />}
        {sources && sources.total > 25 && (
          <div className="pager">
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>← Newer</button>
            <span className="muted tabular">{offset + 1}–{Math.min(sources.total, offset + 25)} of {sources.total}</span>
            <button disabled={offset + 25 >= sources.total} onClick={() => setOffset(offset + 25)}>Older →</button>
          </div>
        )}
        {t.aliases?.length > 0 && <p className="muted" style={{ fontSize: 12 }}>Matched phrases: {t.aliases.join(", ")} · first seen {ago(t.firstSeenAt)}</p>}
      </section>
    </main>
  );
}
