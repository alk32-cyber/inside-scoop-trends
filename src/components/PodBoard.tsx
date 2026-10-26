"use client";
import { useCallback, useEffect, useState } from "react";
import { ago } from "./format";

interface Lane {
  id: string;
  label: string;
  emoji: string;
  count?: number;
}
interface Topic {
  id: string;
  name: string;
  lane: Lane;
  podScore: number;
  tier: "hot" | "solid" | "maybe" | "skip";
  tierLabel: string;
  tierEmoji: string;
  reasons: string[];
  starters: string[];
  startersSource: "ai" | "template";
  summary: string | null;
  headlines: Array<{ title: string; url: string; outlet: string | null; publishedAt: string | null }>;
  stories: number;
  outlets: number;
  newestAt: string | null;
  heavy: boolean;
  isDemo: boolean;
}
interface Response {
  mode: "live" | "demo";
  lanes: Lane[];
  total: number;
  lastUpdated: string | null;
  items: Topic[];
}

const SORTS = [
  { id: "best", label: "Best for the pod" },
  { id: "newest", label: "Newest" },
  { id: "rising", label: "Fastest rising" },
];

const TIER_HEADINGS: Record<Topic["tier"], { title: string; sub: string }> = {
  hot: { title: "🔥 Talk about this", sub: "The strongest picks for this week's episode" },
  solid: { title: "👍 Solid picks", sub: "Good topics, worth a segment" },
  maybe: { title: "😐 Maybe", sub: "Could work with the right angle" },
  skip: { title: "🥶 Skip for now", sub: "Not enough buzz yet, or not a great fit for the show" },
};

export function PodBoard() {
  const [lane, setLane] = useState<string>("");
  const [sort, setSort] = useState("best");
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSkip, setShowSkip] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams({ sort, limit: "100" });
    if (lane) p.set("lane", lane);
    try {
      const r = await fetch(`/api/topics?${p}`);
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [lane, sort]);

  useEffect(() => {
    load();
  }, [load]);

  const items = data?.items ?? [];
  const grouped = sort === "best";
  const tiers: Topic["tier"][] = ["hot", "solid", "maybe", "skip"];

  return (
    <main className="pod">
      <section className="pod-hero">
        <h1>What should we talk about? 🎙️</h1>
        <p>
          Business topics teens actually care about, ranked <b>best → worst</b> for the podcast. Fresh from 16 news sources every day
          {data?.lastUpdated ? ` · updated ${ago(data.lastUpdated)}` : ""}.
        </p>
      </section>

      {data?.mode === "demo" && (
        <div className="banner demo" role="note">
          🧪 <span><strong>Demo data.</strong> These topics are made up to show how the board works.</span>
        </div>
      )}

      <div className="pod-controls">
        <div className="lane-chips" role="group" aria-label="Topic type">
          <button className="lane-chip" aria-pressed={lane === ""} onClick={() => setLane("")}>
            ✨ Everything
          </button>
          {data?.lanes
            .filter((l) => (l.count ?? 0) > 0 || l.id === lane)
            .map((l) => (
              <button key={l.id} className="lane-chip" aria-pressed={lane === l.id} onClick={() => setLane(lane === l.id ? "" : l.id)}>
                {l.emoji} {l.label} <span className="lane-count">{l.count}</span>
              </button>
            ))}
        </div>
        <label className="sort-select">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="banner error" role="alert">
          😬 <span>Couldn&apos;t load topics ({error}). <button className="link-btn" onClick={load}>Try again</button></span>
        </div>
      )}

      {loading && !data && (
        <div className="pod-list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 180 }} />
          ))}
        </div>
      )}

      {data && items.length === 0 && !error && (
        <div className="card empty">
          <h3>Nothing here yet 👀</h3>
          <p className="secondary">{lane ? "No topics in this category right now. Try “Everything”." : "The first news collection hasn't run yet. Check back after the next daily update."}</p>
        </div>
      )}

      {grouped
        ? tiers.map((tier) => {
            const list = items.filter((t) => t.tier === tier);
            if (list.length === 0) return null;
            const collapsed = tier === "skip" && !showSkip;
            return (
              <section key={tier} className={`tier-section tier-${tier}`}>
                <div className="tier-heading">
                  <h2>
                    {TIER_HEADINGS[tier].title} <span className="tier-count">{list.length}</span>
                  </h2>
                  <p>{TIER_HEADINGS[tier].sub}</p>
                </div>
                {collapsed ? (
                  <button className="show-skip" onClick={() => setShowSkip(true)}>
                    Show {list.length} lower-ranked {list.length === 1 ? "topic" : "topics"}
                  </button>
                ) : (
                  <div className="pod-list">
                    {list.map((t) => (
                      <TopicCard key={t.id} t={t} rank={items.indexOf(t) + 1} compact={tier === "skip"} />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        : (
          <div className="pod-list">
            {items.map((t, i) => (
              <TopicCard key={t.id} t={t} rank={i + 1} compact={t.tier === "skip"} />
            ))}
          </div>
        )}

      <p className="pod-footnote">
        <b>How the ranking works:</b> Pod Score = how much teens care about it (40%) + how many outlets cover it (25%) + how fast it&apos;s growing (20%) + how new it
        is (15%). Heavy news like wars, lawsuits and politics is pushed down. <a href="/advanced">Nerd view</a> · <a href="/status">System status</a>
      </p>
    </main>
  );
}

function TopicCard({ t, rank, compact }: { t: Topic; rank: number; compact: boolean }) {
  const [more, setMore] = useState(false);
  const [top, ...rest] = t.headlines;
  const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : null;
  return (
    <article className={`pod-card tier-${t.tier}${compact ? " compact" : ""}`}>
      <div className="pod-card-head">
        <div className="pod-rank" aria-label={`Rank ${rank}`}>
          {medal ?? `#${rank}`}
        </div>
        <div className="pod-title">
          <div className="pod-badges">
            <span className={`tier-badge tier-${t.tier}`}>
              {t.tierEmoji} {t.tierLabel}
            </span>
            <span className="lane-tag">
              {t.lane.emoji} {t.lane.label}
            </span>
            {t.isDemo && <span className="chip demo">Demo</span>}
          </div>
          <h3>
            <a href={`/topics/${t.id}`}>{t.name}</a>
          </h3>
        </div>
        <div className="pod-score" title="Pod Score: how good this is for the show right now (0-100)">
          <span className="pod-score-num">{t.podScore}</span>
          <span className="pod-score-label">Pod Score</span>
        </div>
      </div>

      {top && (
        <div className="pod-news">
          <span className="pod-news-label">What&apos;s happening</span>
          <a href={top.url} target="_blank" rel="noopener noreferrer nofollow" className="pod-headline">
            {top.title}
          </a>
          <span className="muted pod-meta">
            {top.outlet ?? "News"}
            {top.publishedAt ? ` · ${ago(top.publishedAt)}` : ""}
            {t.stories > 1 ? ` · ${t.stories} stories from ${t.outlets} ${t.outlets === 1 ? "outlet" : "outlets"}` : ""}
          </span>
          {t.summary && <p className="pod-summary">{t.summary}</p>}
        </div>
      )}

      {!compact && (
        <>
          {t.reasons.length > 0 && (
            <ul className="pod-reasons" aria-label="Why it's a good pick">
              {t.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <div className="pod-starters">
            <span className="pod-news-label">🎤 Ask on the mic</span>
            <ol>
              {t.starters.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
          {rest.length > 0 && (
            <div className="pod-more">
              <button className="link-btn" onClick={() => setMore(!more)} aria-expanded={more}>
                {more ? "Hide" : `+ ${rest.length} more ${rest.length === 1 ? "story" : "stories"}`}
              </button>
              {more && (
                <ul>
                  {rest.map((h) => (
                    <li key={h.url}>
                      <a href={h.url} target="_blank" rel="noopener noreferrer nofollow">
                        {h.title}
                      </a>{" "}
                      <span className="muted">· {h.outlet ?? "News"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      {compact && t.reasons.length > 0 && <p className="muted pod-meta">{t.reasons.slice(-1)[0]}</p>}
    </article>
  );
}
