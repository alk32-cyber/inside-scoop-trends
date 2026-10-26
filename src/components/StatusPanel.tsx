"use client";
import { useEffect, useState } from "react";
import { ago, utc } from "./format";

/* eslint-disable @typescript-eslint/no-explicit-any */
const STATE: Record<string, { icon: string; label: string; color: string }> = {
  connected: { icon: "✓", label: "Connected (verified by a successful collection)", color: "var(--status-good-text)" },
  configured_untested: { icon: "…", label: "Credentials set — not yet tested", color: "var(--text-secondary)" },
  not_configured: { icon: "○", label: "Not configured — awaiting credentials", color: "var(--text-muted)" },
  failing: { icon: "✕", label: "Failing", color: "var(--status-critical-text)" },
  demo: { icon: "🧪", label: "Demo data (simulated)", color: "var(--demo-ink)" },
};

export function StatusPanel() {
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/system/status")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((x) => {
          setS(x);
          setErr(null);
        })
        .catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  if (err) return <div className="banner error" role="alert">✕ <span>Could not load system status: {err}</span></div>;
  if (!s) return <div className="skeleton" style={{ height: 200 }} aria-busy="true" />;

  return (
    <main className="page">
      <div>
        <h1>System status</h1>
        <p className="secondary" style={{ margin: "4px 0 0" }}>
          Mode: <b>{s.mode === "demo" ? "Demo (simulated data)" : "Live"}</b> · Database: {s.database} · Checked {utc(s.now)}
        </p>
      </div>
      {s.mode === "demo" && (
        <div className="banner demo">🧪 <span>Showing <b>demo</b> ingestion runs. Live provider health is shown when DEMO_MODE is off.</span></div>
      )}
      <div className="status-grid">
        {s.providers.map((p: any) => {
          const st = STATE[p.connection];
          return (
            <section className="card status-card" key={p.provider}>
              <h3>{p.label}</h3>
              <span className="state" style={{ color: st.color }}>
                <span className="state-icon" aria-hidden="true">{st.icon}</span> {st.label}
              </span>
              <dl className="kv tabular">
                {p.missingEnv.length > 0 && (<><dt>Missing</dt><dd><code>{p.missingEnv.join(", ")}</code></dd></>)}
                <dt>Last success</dt><dd>{p.lastSuccessAt ? `${utc(p.lastSuccessAt)} (${ago(p.lastSuccessAt)})` : "never"}{p.lastSuccessAt && p.stale ? " — stale" : ""}</dd>
                <dt>Last attempt</dt><dd>{p.lastAttemptAt ? `${ago(p.lastAttemptAt)} · ${p.lastAttemptStatus}` : "never"}</dd>
                <dt>Newest item</dt><dd>{p.newestItemAt ? utc(p.newestItemAt) : "—"}</dd>
                <dt>Schedule</dt><dd>every {p.scheduleMinutes} min</dd>
                <dt>Requests (24h)</dt><dd>{p.requestsLast24h} / {p.dailyRequestBudget} budget</dd>
                <dt>Runs (24h)</dt><dd>{p.runsLast24h} ({p.failuresLast24h} failed)</dd>
              </dl>
              {p.lastError && (
                <p className="banner error" style={{ margin: "10px 0 0", fontSize: 12 }}>
                  {p.lastError.status === "partial" ? "Partial run" : "Error"} {ago(p.lastError.at)}: {p.lastError.message}
                </p>
              )}
              {p.notes && <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>{p.notes}</p>}
              <p style={{ fontSize: 12, marginBottom: 0 }}>
                <a href={p.docsUrl} target="_blank" rel="noopener noreferrer">Provider docs</a> · {p.attribution}
              </p>
            </section>
          );
        })}
      </div>
      <section className="card panel">
        <h2 className="section-title">Pipeline</h2>
        <dl className="kv">
          <dt>Last pipeline run</dt><dd>{s.pipeline ? `${utc(s.pipeline.lastRunAt)} · ${s.pipeline.status}${s.pipeline.error ? ` — ${s.pipeline.error}` : ""}` : "never"}</dd>
          <dt>Topics scored</dt><dd>{s.scoring.topicsScored} (last {s.scoring.lastScoredAt ? utc(s.scoring.lastScoredAt) : "never"})</dd>
          <dt>AI analysis</dt><dd>{s.analysis.llmConfigured ? `enabled (${s.analysis.model})` : "not configured — template summaries are used"}</dd>
          <dt>Semantic grouping</dt><dd>{s.embeddings.configured ? "embeddings enabled" : "deterministic rules only (no embedding key)"}</dd>
        </dl>
      </section>
    </main>
  );
}
