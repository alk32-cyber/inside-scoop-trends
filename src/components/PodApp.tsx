"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ago } from "./format";

/*
 * Spotify-style topic player. Topics are "tracks", playlists are built from the live ranking
 * (top picks, fresh, rising, one per topic type), and people can make their own playlists for an
 * episode. Your playlists live in this browser only; "Share" puts the topic list in a link.
 */

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
  nerd: { trendScore: number; lifecycle: string };
  isDemo: boolean;
}
interface ApiResponse {
  mode: "live" | "demo";
  lanes: Lane[];
  lastUpdated: string | null;
  items: Topic[];
}

/** What a saved playlist remembers about a topic, so it still shows after the topic stops trending. */
interface SavedTopic {
  id: string;
  name: string;
  emoji: string;
}
interface UserPlaylist {
  id: string;
  name: string;
  topics: SavedTopic[];
  createdAt: number;
}

type View = { kind: "home" } | { kind: "search"; q?: string } | { kind: "playlist"; id: string } | { kind: "library" };

interface Playlist {
  id: string;
  name: string;
  emoji: string;
  blurb: string;
  hue: number;
  topics: Topic[];
  /** Saved topics that are no longer in today's feed. */
  missing: SavedTopic[];
  user?: UserPlaylist;
  shared?: boolean;
}

const STORE_KEY = "inside-scoop-playlists-v1";
const SEGMENT_SECONDS = 5 * 60;

function loadPlaylists(): UserPlaylist[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as UserPlaylist[]) : null;
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* storage blocked or corrupt: start fresh */
  }
  return [{ id: "next-episode", name: "Next episode", topics: [], createdAt: Date.now() }];
}
function savePlaylists(p: UserPlaylist[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p));
  } catch {
    /* private window: playlists last for this visit only */
  }
}

function viewFromUrl(): View {
  const p = new URLSearchParams(window.location.search);
  const v = p.get("view");
  if (v === "search") return { kind: "search", q: p.get("q") ?? "" };
  if (v === "library") return { kind: "library" };
  if (v === "playlist" && p.get("id")) return { kind: "playlist", id: p.get("id")! };
  if (p.get("shared")) return { kind: "playlist", id: "shared" };
  return { kind: "home" };
}
function urlFor(v: View, shared: { name: string; ids: string[] } | null): string {
  if (v.kind === "home") return "/";
  if (v.kind === "search") return v.q ? `/?view=search&q=${encodeURIComponent(v.q)}` : "/?view=search";
  if (v.kind === "library") return "/?view=library";
  if (v.id === "shared" && shared) return `/?shared=${shared.ids.map(encodeURIComponent).join(",")}&name=${encodeURIComponent(shared.name)}`;
  return `/?view=playlist&id=${encodeURIComponent(v.id)}`;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? "Up late?" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};
const LANE_HUES: Record<string, number> = { creators: 330, gaming: 265, money: 145, tech: 210, brands: 25, entertainment: 0, startups: 45, other: 220 };

export function PodApp() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [mine, setMine] = useState<UserPlaylist[]>([]);
  const [shared, setShared] = useState<{ name: string; ids: string[] } | null>(null);
  const [queue, setQueue] = useState<{ playlistId: string; ids: string[] } | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [questionIdx, setQuestionIdx] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const sharedRef = useRef<{ name: string; ids: string[] } | null>(null);
  sharedRef.current = shared;

  // ---------- data + persistence ----------
  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/topics?limit=100&sort=best");
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error?.message ?? `HTTP ${r.status}`);
      setData(await r.json());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    setMine(loadPlaylists());
    const p = new URLSearchParams(window.location.search);
    if (p.get("shared")) setShared({ name: p.get("name") || "Shared playlist", ids: p.get("shared")!.split(",").filter(Boolean).slice(0, 100) });
    setView(viewFromUrl());
    const onPop = () => setView(viewFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [load]);

  const updateMine = useCallback((fn: (p: UserPlaylist[]) => UserPlaylist[]) => {
    setMine((prev) => {
      const next = fn(prev);
      savePlaylists(next);
      return next;
    });
  }, []);

  const go = useCallback((v: View) => {
    setView(v);
    window.history.pushState(null, "", urlFor(v, sharedRef.current));
    mainRef.current?.scrollTo({ top: 0 });
  }, []);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2200);
  }, []);

  // ---------- playlists ----------
  const topics = useMemo(() => data?.items ?? [], [data]);
  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);

  const playlists = useMemo<Playlist[]>(() => {
    const best = [...topics].sort((a, b) => b.podScore - a.podScore);
    const list: Playlist[] = [
      { id: "top", name: "Top picks this week", emoji: "🔥", blurb: "The strongest topics for the next episode, best first.", hue: 18, topics: best.filter((t) => t.tier === "hot" || t.tier === "solid"), missing: [] },
      {
        id: "fresh",
        name: "Fresh drops",
        emoji: "🆕",
        blurb: "Newest stories from the last day.",
        hue: 190,
        topics: [...topics].filter((t) => t.newestAt && Date.now() - Date.parse(t.newestAt) < 36 * 3600_000).sort((a, b) => Date.parse(b.newestAt!) - Date.parse(a.newestAt!)),
        missing: [],
      },
      { id: "rising", name: "Rising fast", emoji: "📈", blurb: "Topics growing fastest against their own normal.", hue: 140, topics: [...topics].sort((a, b) => b.nerd.trendScore - a.nerd.trendScore).slice(0, 25), missing: [] },
    ];
    for (const lane of data?.lanes ?? []) {
      const inLane = best.filter((t) => t.lane.id === lane.id);
      if (inLane.length) list.push({ id: `lane-${lane.id}`, name: lane.label, emoji: lane.emoji, blurb: `${lane.label}, ranked best to worst for the pod.`, hue: LANE_HUES[lane.id] ?? 220, topics: inLane, missing: [] });
    }
    list.push({ id: "all", name: "Everything, best → worst", emoji: "🎧", blurb: "Every topic in the feed, including the ones to skip.", hue: 220, topics: best, missing: [] });
    for (const u of mine) {
      list.push({
        id: `my-${u.id}`,
        name: u.name,
        emoji: "🎙️",
        blurb: "Your playlist. Saved in this browser.",
        hue: 260,
        topics: u.topics.map((s) => byId.get(s.id)).filter((t): t is Topic => !!t),
        missing: u.topics.filter((s) => !byId.has(s.id)),
        user: u,
      });
    }
    if (shared) {
      list.push({
        id: "shared",
        name: shared.name,
        emoji: "🔗",
        blurb: "A playlist someone shared with you.",
        hue: 300,
        topics: shared.ids.map((id) => byId.get(id)).filter((t): t is Topic => !!t),
        missing: shared.ids.filter((id) => !byId.has(id)).map((id) => ({ id, name: id.replace(/-/g, " "), emoji: "📰" })),
        shared: true,
      });
    }
    return list;
  }, [topics, data, mine, shared, byId]);

  const plById = useMemo(() => new Map(playlists.map((p) => [p.id, p])), [playlists]);

  const addTo = useCallback(
    (playlistId: string, t: Topic) => {
      updateMine((prev) => prev.map((p) => (p.id === playlistId && !p.topics.some((s) => s.id === t.id) ? { ...p, topics: [...p.topics, { id: t.id, name: t.name, emoji: t.lane.emoji }] } : p)));
      const name = mine.find((p) => p.id === playlistId)?.name ?? "playlist";
      flash(`Added to ${name}`);
    },
    [updateMine, mine, flash],
  );
  const createPlaylist = useCallback(
    (name?: string, seed?: SavedTopic[]) => {
      const p: UserPlaylist = { id: Math.random().toString(36).slice(2, 9), name: name || `My playlist #${mine.length + 1}`, topics: seed ?? [], createdAt: Date.now() };
      updateMine((prev) => [...prev, p]);
      return p;
    },
    [mine.length, updateMine],
  );

  // ---------- player ----------
  const current = currentId ? byId.get(currentId) ?? null : null;

  const play = useCallback((pl: Playlist, startId?: string) => {
    const ids = pl.topics.map((t) => t.id);
    if (!ids.length) return;
    setQueue({ playlistId: pl.id, ids });
    setCurrentId(startId ?? ids[0]);
    setElapsed(0);
    setQuestionIdx(0);
    setPlaying(true);
  }, []);
  const select = useCallback((t: Topic, pl?: Playlist) => {
    setCurrentId(t.id);
    setPanelOpen(true);
    setElapsed(0);
    setQuestionIdx(0);
    if (pl && (!queue || queue.playlistId !== pl.id)) setQueue({ playlistId: pl.id, ids: pl.topics.map((x) => x.id) });
  }, [queue]);
  const step = useCallback(
    (dir: 1 | -1) => {
      if (!queue || !currentId) return;
      const i = queue.ids.indexOf(currentId);
      const next = queue.ids[i + dir];
      if (next) {
        setCurrentId(next);
        setElapsed(0);
        setQuestionIdx(0);
      }
    },
    [queue, currentId],
  );

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, [playing]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space" && current) {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === "Escape") setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);

  // ---------- render ----------
  const userPlaylists = playlists.filter((p) => p.user);
  const madeFor = playlists.filter((p) => !p.user && !p.shared);
  const ctx: Ctx = { go, play, select, addTo, createPlaylist, mine, current, playing, setPlaying, flash, updateMine, plById };

  return (
    <div className={`sp-app${current ? " has-player" : ""}${panelOpen && current ? " panel-open" : ""}`}>
      <aside className="sp-side" aria-label="Library">
        <div className="sp-side-box">
          <a className="sp-brand" href="/" onClick={(e) => (e.preventDefault(), go({ kind: "home" }))}>
            <span className="sp-logo" aria-hidden="true">IS</span>
            <span>
              <span className="sp-brand-name">Inside Scoop</span>
              <span className="sp-brand-sub">Topic player</span>
            </span>
          </a>
          <nav className="sp-mainnav">
            <button aria-current={view.kind === "home" ? "page" : undefined} onClick={() => go({ kind: "home" })}>
              <span aria-hidden="true">⌂</span> Home
            </button>
            <button aria-current={view.kind === "search" ? "page" : undefined} onClick={() => go({ kind: "search" })}>
              <span aria-hidden="true">⌕</span> Search
            </button>
          </nav>
        </div>
        <div className="sp-side-box sp-library">
          <div className="sp-library-head">
            <button className="sp-library-title" onClick={() => go({ kind: "library" })}>
              <span aria-hidden="true">▤</span> Your Library
            </button>
            <button className="sp-icon-btn" aria-label="Create playlist" title="Create playlist" onClick={() => go({ kind: "playlist", id: `my-${createPlaylist().id}` })}>
              +
            </button>
          </div>
          <ul className="sp-library-list">
            {[...userPlaylists, ...playlists.filter((p) => p.shared), ...madeFor].map((p) => (
              <li key={p.id}>
                <button className="sp-lib-item" aria-current={view.kind === "playlist" && view.id === p.id ? "page" : undefined} onClick={() => go({ kind: "playlist", id: p.id })}>
                  <Cover p={p} size="sm" />
                  <span className="sp-lib-text">
                    <span className={`sp-lib-name${queue?.playlistId === p.id && playing ? " is-playing" : ""}`}>{p.name}</span>
                    <span className="sp-lib-sub">
                      {p.user ? "Your playlist" : p.shared ? "Shared" : "Made for Inside Scoop"} · {p.topics.length + p.missing.length} {p.topics.length + p.missing.length === 1 ? "topic" : "topics"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="sp-side-links">
            <a href="/advanced">Nerd view</a>
            <a href="/status">System status</a>
          </div>
        </div>
      </aside>

      <main className="sp-main" ref={mainRef}>
        {data?.mode === "demo" && (
          <div className="banner demo" role="note">
            🧪 <span><strong>Demo data.</strong> These topics are made up to show how the player works.</span>
          </div>
        )}
        {error && (
          <div className="banner error" role="alert">
            😬 <span>Couldn&apos;t load topics ({error}). <button className="link-btn" onClick={load}>Try again</button></span>
          </div>
        )}
        {!data && !error && <div className="sp-loading">Loading today&apos;s topics…</div>}
        {data && view.kind === "home" && <Home ctx={ctx} madeFor={madeFor} mine={userPlaylists} topics={topics} lastUpdated={data.lastUpdated} />}
        {data && view.kind === "search" && <Search ctx={ctx} topics={topics} playlists={madeFor} initial={view.q ?? ""} />}
        {data && view.kind === "library" && <Library ctx={ctx} playlists={[...userPlaylists, ...madeFor]} />}
        {data && view.kind === "playlist" && (plById.get(view.id) ? <PlaylistView ctx={ctx} p={plById.get(view.id)!} queueId={queue?.playlistId ?? null} /> : <NotFound go={go} />)}
      </main>

      {current && panelOpen && (
        <aside className="sp-now" aria-label="Now playing">
          <NowPlaying ctx={ctx} t={current} questionIdx={questionIdx} setQuestionIdx={setQuestionIdx} onClose={() => setPanelOpen(false)} />
        </aside>
      )}

      {current && (
        <footer className="sp-player" aria-label="Player">
          <button className="sp-player-track" onClick={() => setPanelOpen((o) => !o)} aria-expanded={panelOpen}>
            <TopicArt t={current} size="sm" />
            <span className="sp-player-text">
              <span className="sp-player-name">{current.name}</span>
              <span className="sp-player-sub">
                {current.lane.emoji} {current.lane.label} · Pod Score {current.podScore}
              </span>
            </span>
          </button>
          <div className="sp-player-center">
            <div className="sp-controls">
              <button className="sp-ctrl" aria-label="Previous topic" onClick={() => step(-1)} disabled={!queue || queue.ids.indexOf(current.id) <= 0}>
                ⏮
              </button>
              <button className="sp-play" aria-label={playing ? "Pause segment timer" : "Start segment timer"} onClick={() => setPlaying((p) => !p)}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button className="sp-ctrl" aria-label="Next topic" onClick={() => step(1)} disabled={!queue || queue.ids.indexOf(current.id) >= queue.ids.length - 1}>
                ⏭
              </button>
            </div>
            <div className="sp-progress" title="Segment timer: aim for about 5 minutes per topic">
              <span className="tabular">{fmtTime(elapsed)}</span>
              <span className="sp-bar">
                <span className={`sp-bar-fill${elapsed > SEGMENT_SECONDS ? " over" : ""}`} style={{ width: `${Math.min(100, (elapsed / SEGMENT_SECONDS) * 100)}%` }} />
              </span>
              <span className="tabular">{fmtTime(SEGMENT_SECONDS)}</span>
            </div>
          </div>
          <div className="sp-player-right">
            {current.starters.length > 0 && (
              <button className="sp-question" onClick={() => setQuestionIdx((i) => (i + 1) % current.starters.length)} title="Next question">
                🎤 <span>{current.starters[questionIdx % current.starters.length]}</span>
              </button>
            )}
          </div>
        </footer>
      )}

      <nav className="sp-tabs" aria-label="Sections">
        <button aria-current={view.kind === "home" ? "page" : undefined} onClick={() => go({ kind: "home" })}>
          <span aria-hidden="true">⌂</span>Home
        </button>
        <button aria-current={view.kind === "search" ? "page" : undefined} onClick={() => go({ kind: "search" })}>
          <span aria-hidden="true">⌕</span>Search
        </button>
        <button aria-current={view.kind === "library" || view.kind === "playlist" ? "page" : undefined} onClick={() => go({ kind: "library" })}>
          <span aria-hidden="true">▤</span>Library
        </button>
      </nav>

      {toast && (
        <div className="sp-toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

interface Ctx {
  go: (v: View) => void;
  play: (p: Playlist, startId?: string) => void;
  select: (t: Topic, p?: Playlist) => void;
  addTo: (playlistId: string, t: Topic) => void;
  createPlaylist: (name?: string, seed?: SavedTopic[]) => UserPlaylist;
  mine: UserPlaylist[];
  current: Topic | null;
  playing: boolean;
  setPlaying: (fn: (p: boolean) => boolean) => void;
  flash: (m: string) => void;
  updateMine: (fn: (p: UserPlaylist[]) => UserPlaylist[]) => void;
  plById: Map<string, Playlist>;
}

// ---------- art ----------
function Cover({ p, size }: { p: Playlist; size: "sm" | "md" | "lg" }) {
  return (
    <span className={`sp-cover sp-cover-${size}`} style={{ "--hue": p.hue } as React.CSSProperties} aria-hidden="true">
      <span className="sp-cover-emoji">{p.emoji}</span>
    </span>
  );
}
function TopicArt({ t, size }: { t: Topic; size: "sm" | "md" | "lg" }) {
  return (
    <span className={`sp-cover sp-cover-${size} tier-${t.tier}`} style={{ "--hue": LANE_HUES[t.lane.id] ?? 220 } as React.CSSProperties} aria-hidden="true">
      <span className="sp-cover-emoji">{t.lane.emoji}</span>
      {size !== "sm" && <span className="sp-cover-score">{t.podScore}</span>}
    </span>
  );
}

// ---------- views ----------
function Home({ ctx, madeFor, mine, topics, lastUpdated }: { ctx: Ctx; madeFor: Playlist[]; mine: Playlist[]; topics: Topic[]; lastUpdated: string | null }) {
  const quick = [...mine.slice(0, 2), ...madeFor].slice(0, 6);
  const top = [...topics].sort((a, b) => b.podScore - a.podScore).slice(0, 10);
  const all = ctx.plById.get("all");
  return (
    <div className="sp-view sp-home">
      <header className="sp-home-head">
        <h1>{greeting()} 🎙️</h1>
        <p className="secondary">
          What should Inside Scoop talk about? Business topics teens actually care about, ranked best → worst.
          {lastUpdated ? ` Updated ${ago(lastUpdated)}.` : ""}
        </p>
      </header>
      <div className="sp-quick">
        {quick.map((p) => (
          <div key={p.id} className="sp-quick-item">
            <button className="sp-quick-main" onClick={() => ctx.go({ kind: "playlist", id: p.id })}>
              <Cover p={p} size="sm" />
              <span>{p.name}</span>
            </button>
            {p.topics.length > 0 && (
              <button className="sp-fab sm" aria-label={`Play ${p.name}`} onClick={() => ctx.play(p)}>
                ▶
              </button>
            )}
          </div>
        ))}
      </div>

      {topics.length === 0 ? (
        <div className="sp-empty">
          <h3>Nothing here yet 👀</h3>
          <p className="secondary">The first news collection hasn&apos;t run yet. Check back after the next daily update.</p>
        </div>
      ) : (
        <>
          <Shelf title="Top topics right now" more={all ? () => ctx.go({ kind: "playlist", id: "all" }) : undefined}>
            {top.map((t, i) => (
              <button key={t.id} className="sp-card" onClick={() => ctx.select(t, all)}>
                <TopicArt t={t} size="md" />
                <span className="sp-card-title">
                  {i < 3 ? ["🥇", "🥈", "🥉"][i] + " " : ""}
                  {t.name}
                </span>
                <span className="sp-card-sub">{t.headlines[0]?.title ?? t.lane.label}</span>
              </button>
            ))}
          </Shelf>
          <Shelf title="Made for Inside Scoop">
            {madeFor.map((p) => (
              <PlaylistCard key={p.id} p={p} ctx={ctx} />
            ))}
          </Shelf>
          {mine.length > 0 && (
            <Shelf title="Your playlists">
              {mine.map((p) => (
                <PlaylistCard key={p.id} p={p} ctx={ctx} />
              ))}
            </Shelf>
          )}
        </>
      )}
      <p className="pod-footnote">
        <b>How the ranking works:</b> Pod Score = how much teens care about it (40%) + how many outlets cover it (25%) + how fast it&apos;s growing (20%) + how new it is (15%). Heavy
        news like wars, lawsuits and politics is pushed down. The ▶ button starts a 5-minute segment timer for recording.
      </p>
    </div>
  );
}

function Shelf({ title, more, children }: { title: string; more?: () => void; children: React.ReactNode }) {
  return (
    <section className="sp-shelf">
      <div className="sp-shelf-head">
        <h2>{title}</h2>
        {more && (
          <button className="sp-link" onClick={more}>
            Show all
          </button>
        )}
      </div>
      <div className="sp-shelf-row">{children}</div>
    </section>
  );
}

function PlaylistCard({ p, ctx }: { p: Playlist; ctx: Ctx }) {
  return (
    <div className="sp-card">
      <button className="sp-card-hit" onClick={() => ctx.go({ kind: "playlist", id: p.id })} aria-label={`Open ${p.name}`} />
      <span className="sp-card-art">
        <Cover p={p} size="md" />
        {p.topics.length > 0 && (
          <button className="sp-fab" aria-label={`Play ${p.name}`} onClick={() => ctx.play(p)}>
            ▶
          </button>
        )}
      </span>
      <span className="sp-card-title">{p.name}</span>
      <span className="sp-card-sub">{p.blurb}</span>
    </div>
  );
}

function Search({ ctx, topics, playlists, initial }: { ctx: Ctx; topics: Topic[]; playlists: Playlist[]; initial: string }) {
  const [q, setQ] = useState(initial);
  const needle = q.trim().toLowerCase();
  const results = needle
    ? topics.filter((t) => t.name.toLowerCase().includes(needle) || t.lane.label.toLowerCase().includes(needle) || t.headlines.some((h) => h.title.toLowerCase().includes(needle)))
    : [];
  const fake: Playlist = { id: "all", name: "Search", emoji: "⌕", blurb: "", hue: 220, topics: results, missing: [] };
  return (
    <div className="sp-view">
      <label className="sp-search">
        <span aria-hidden="true">⌕</span>
        <span className="sr-only">Search topics</span>
        <input
          autoFocus
          value={q}
          placeholder="What do you want to talk about?"
          onChange={(e) => {
            setQ(e.target.value);
            window.history.replaceState(null, "", e.target.value ? `/?view=search&q=${encodeURIComponent(e.target.value)}` : "/?view=search");
          }}
        />
      </label>
      {needle ? (
        results.length ? (
          <TrackList ctx={ctx} p={fake} />
        ) : (
          <div className="sp-empty">
            <h3>No topics match “{q}”</h3>
            <p className="secondary">Try a brand, an app, or a word like “AI”, “gaming” or “money”.</p>
          </div>
        )
      ) : (
        <>
          <h2 className="sp-h2">Browse all</h2>
          <div className="sp-browse">
            {playlists.map((p) => (
              <button key={p.id} className="sp-tile" style={{ "--hue": p.hue } as React.CSSProperties} onClick={() => ctx.go({ kind: "playlist", id: p.id })}>
                <span>{p.name}</span>
                <span className="sp-tile-emoji" aria-hidden="true">
                  {p.emoji}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Library({ ctx, playlists }: { ctx: Ctx; playlists: Playlist[] }) {
  return (
    <div className="sp-view">
      <div className="sp-shelf-head">
        <h1 className="sp-h1">Your Library</h1>
        <button className="sp-pill" onClick={() => ctx.go({ kind: "playlist", id: `my-${ctx.createPlaylist().id}` })}>
          + New playlist
        </button>
      </div>
      <div className="sp-grid">
        {playlists.map((p) => (
          <PlaylistCard key={p.id} p={p} ctx={ctx} />
        ))}
      </div>
    </div>
  );
}

function NotFound({ go }: { go: (v: View) => void }) {
  return (
    <div className="sp-view sp-empty">
      <h3>That playlist isn&apos;t here</h3>
      <p className="secondary">It may have been deleted, or it was made in another browser.</p>
      <button className="sp-pill" onClick={() => go({ kind: "home" })}>
        Go home
      </button>
    </div>
  );
}

function PlaylistView({ ctx, p, queueId }: { ctx: Ctx; p: Playlist; queueId: string | null }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  useEffect(() => setName(p.name), [p.name]);
  const isQueue = queueId === p.id;
  const total = p.topics.length + p.missing.length;

  const share = async () => {
    const ids = [...p.topics.map((t) => t.id), ...p.missing.map((m) => m.id)];
    const url = `${window.location.origin}/?shared=${ids.map(encodeURIComponent).join(",")}&name=${encodeURIComponent(p.name)}`;
    try {
      await navigator.clipboard.writeText(url);
      ctx.flash("Link copied: send it to your co-host");
    } catch {
      window.prompt("Copy this link", url);
    }
  };
  const commitRename = () => {
    setRenaming(false);
    const n = name.trim();
    if (p.user && n && n !== p.user.name) ctx.updateMine((prev) => prev.map((x) => (x.id === p.user!.id ? { ...x, name: n.slice(0, 60) } : x)));
  };

  return (
    <div className="sp-view sp-playlist" style={{ "--hue": p.hue } as React.CSSProperties}>
      <header className="sp-pl-head">
        <Cover p={p} size="lg" />
        <div className="sp-pl-meta">
          <span className="sp-pl-kind">{p.user ? "Your playlist" : p.shared ? "Shared playlist" : "Playlist"}</span>
          {renaming && p.user ? (
            <input
              className="sp-rename"
              value={name}
              autoFocus
              maxLength={60}
              aria-label="Playlist name"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") (setName(p.name), setRenaming(false));
              }}
            />
          ) : (
            <h1 className="sp-pl-title" onClick={() => p.user && setRenaming(true)} title={p.user ? "Click to rename" : undefined}>
              {p.name}
            </h1>
          )}
          <p className="secondary">{p.blurb}</p>
          <p className="sp-pl-stats">
            <b>Inside Scoop</b> · {total} {total === 1 ? "topic" : "topics"}
            {p.topics.length ? ` · about ${p.topics.length * 5} min of show` : ""}
          </p>
        </div>
      </header>

      <div className="sp-actions">
        <button className="sp-fab lg" aria-label={isQueue && ctx.playing ? "Pause" : `Play ${p.name}`} disabled={!p.topics.length} onClick={() => (isQueue ? ctx.setPlaying((x) => !x) : ctx.play(p))}>
          {isQueue && ctx.playing ? "❚❚" : "▶"}
        </button>
        {total > 0 && (
          <button className="sp-pill ghost" onClick={share}>
            🔗 Share
          </button>
        )}
        {p.shared && (
          <button
            className="sp-pill ghost"
            onClick={() => {
              const made = ctx.createPlaylist(p.name, [...p.topics.map((t) => ({ id: t.id, name: t.name, emoji: t.lane.emoji })), ...p.missing]);
              ctx.go({ kind: "playlist", id: `my-${made.id}` });
              ctx.flash("Saved to your library");
            }}
          >
            ＋ Save to library
          </button>
        )}
        {p.user && (
          <>
            <button className="sp-pill ghost" onClick={() => setRenaming(true)}>
              ✎ Rename
            </button>
            <button
              className="sp-pill ghost danger"
              onClick={() => {
                if (!window.confirm(`Delete “${p.name}”?`)) return;
                ctx.updateMine((prev) => prev.filter((x) => x.id !== p.user!.id));
                ctx.go({ kind: "library" });
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>

      {total === 0 ? (
        <div className="sp-empty">
          <h3>{p.user ? "Let's find some topics for this playlist" : "No topics here right now"}</h3>
          <p className="secondary">{p.user ? "Hit ＋ next to any topic to add it here." : "Check back after the next daily update."}</p>
          {p.user && (
            <button className="sp-pill" onClick={() => ctx.go({ kind: "playlist", id: "top" })}>
              Browse top picks
            </button>
          )}
        </div>
      ) : (
        <TrackList ctx={ctx} p={p} />
      )}
    </div>
  );
}

function TrackList({ ctx, p }: { ctx: Ctx; p: Playlist }) {
  const removable = !!p.user;
  const remove = (id: string) => ctx.updateMine((prev) => prev.map((x) => (x.id === p.user?.id ? { ...x, topics: x.topics.filter((s) => s.id !== id) } : x)));
  return (
    <div className="sp-tracks" role="table" aria-label={`${p.name} topics`}>
      <div className="sp-track sp-track-head" role="row">
        <span role="columnheader">#</span>
        <span role="columnheader">Topic</span>
        <span role="columnheader" className="sp-col-news">
          What&apos;s happening
        </span>
        <span role="columnheader" className="sp-col-time">
          New
        </span>
        <span role="columnheader" className="sp-col-score">
          Pod Score
        </span>
        <span role="columnheader">
          <span className="sr-only">Actions</span>
        </span>
      </div>
      {p.topics.map((t, i) => {
        const active = ctx.current?.id === t.id;
        return (
          <div key={t.id} role="row" className={`sp-track${active ? " active" : ""}`} onClick={() => ctx.select(t, p)} onDoubleClick={() => ctx.play(p, t.id)}>
            <span className="sp-num" role="cell">
              {active && ctx.playing ? <span className="sp-eq" aria-label="Playing"><i /><i /><i /></span> : <span className="sp-num-text">{i + 1}</span>}
              <button
                className="sp-row-play"
                aria-label={`Play ${t.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.play(p, t.id);
                }}
              >
                ▶
              </button>
            </span>
            <span className="sp-title-cell" role="cell">
              <TopicArt t={t} size="sm" />
              <span className="sp-title-text">
                <span className="sp-track-name">{t.name}</span>
                <span className="sp-track-sub">
                  <span className={`sp-tier tier-${t.tier}`}>{t.tierEmoji} {t.tierLabel}</span> {t.lane.emoji} {t.lane.label}
                  {t.isDemo && <span className="chip demo">Demo</span>}
                </span>
              </span>
            </span>
            <span className="sp-col-news sp-news-cell" role="cell">
              {t.headlines[0]?.title ?? "—"}
              {t.headlines[0]?.outlet && <span className="muted"> · {t.headlines[0].outlet.replace(/^www\.|^feeds\./, "")}</span>}
            </span>
            <span className="sp-col-time muted" role="cell">
              {t.newestAt ? ago(t.newestAt) : "—"}
            </span>
            <span className="sp-col-score" role="cell">
              <span className="sp-score-bar" aria-hidden="true">
                <span style={{ width: `${t.podScore}%` }} />
              </span>
              <span className="tabular">{t.podScore}</span>
            </span>
            <span className="sp-row-actions" role="cell" onClick={(e) => e.stopPropagation()}>
              {removable ? (
                <button className="sp-icon-btn" aria-label={`Remove ${t.name}`} title="Remove from playlist" onClick={() => remove(t.id)}>
                  −
                </button>
              ) : (
                <AddMenu ctx={ctx} t={t} />
              )}
            </span>
          </div>
        );
      })}
      {p.missing.map((m) => (
        <div key={m.id} role="row" className="sp-track gone">
          <span className="sp-num" role="cell">
            ·
          </span>
          <span className="sp-title-cell" role="cell">
            <span className="sp-cover sp-cover-sm" aria-hidden="true">
              <span className="sp-cover-emoji">{m.emoji}</span>
            </span>
            <span className="sp-title-text">
              <span className="sp-track-name">{m.name}</span>
              <span className="sp-track-sub">Not trending right now</span>
            </span>
          </span>
          <span className="sp-col-news" role="cell" />
          <span className="sp-col-time" role="cell" />
          <span className="sp-col-score" role="cell" />
          <span className="sp-row-actions" role="cell">
            {removable && (
              <button className="sp-icon-btn" aria-label={`Remove ${m.name}`} onClick={() => remove(m.id)}>
                −
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function AddMenu({ ctx, t }: { ctx: Ctx; t: Topic }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const inAny = ctx.mine.some((p) => p.topics.some((s) => s.id === t.id));
  return (
    <div className="sp-add" ref={ref}>
      <button className={`sp-icon-btn${inAny ? " on" : ""}`} aria-label={`Add ${t.name} to a playlist`} aria-expanded={open} title="Add to playlist" onClick={() => setOpen((o) => !o)}>
        {inAny ? "✓" : "+"}
      </button>
      {open && (
        <div className="sp-menu" role="menu">
          <span className="sp-menu-label">Add to playlist</span>
          {ctx.mine.map((p) => {
            const has = p.topics.some((s) => s.id === t.id);
            return (
              <button
                key={p.id}
                role="menuitem"
                disabled={has}
                onClick={() => {
                  ctx.addTo(p.id, t);
                  setOpen(false);
                }}
              >
                🎙️ {p.name} {has && <span className="muted">✓ added</span>}
              </button>
            );
          })}
          <button
            role="menuitem"
            onClick={() => {
              const name = window.prompt("Name your playlist", `Episode ideas #${ctx.mine.length + 1}`);
              if (name === null) return;
              ctx.createPlaylist(name.trim().slice(0, 60) || undefined, [{ id: t.id, name: t.name, emoji: t.lane.emoji }]);
              ctx.flash("Playlist created");
              setOpen(false);
            }}
          >
            ＋ New playlist
          </button>
        </div>
      )}
    </div>
  );
}

function NowPlaying({ ctx, t, questionIdx, setQuestionIdx, onClose }: { ctx: Ctx; t: Topic; questionIdx: number; setQuestionIdx: (i: number) => void; onClose: () => void }) {
  return (
    <div className="sp-now-inner">
      <div className="sp-now-head">
        <span className="sp-pl-kind">Now playing</span>
        <button className="sp-icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <TopicArt t={t} size="lg" />
      <div className="sp-now-title">
        <div>
          <h2>{t.name}</h2>
          <p className="secondary">
            {t.lane.emoji} {t.lane.label} · <span className={`sp-tier tier-${t.tier}`}>{t.tierEmoji} {t.tierLabel}</span>
          </p>
        </div>
        <AddMenu ctx={ctx} t={t} />
      </div>
      {t.summary && <p className="secondary">{t.summary}</p>}

      <section className="sp-now-card">
        <h3>🎤 Ask on the mic</h3>
        <ol>
          {t.starters.map((s, i) => (
            <li key={s}>
              <button className={i === questionIdx % t.starters.length ? "on" : ""} onClick={() => setQuestionIdx(i)}>
                {s}
              </button>
            </li>
          ))}
        </ol>
        {t.startersSource === "template" && <p className="muted sp-small">Starter questions from a template; they get written from the stories once AI analysis is switched on.</p>}
      </section>

      {t.reasons.length > 0 && (
        <section className="sp-now-card">
          <h3>Why it&apos;s on the list</h3>
          <ul className="sp-reasons">
            {t.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="sp-now-card">
        <h3>
          What&apos;s happening · {t.stories} {t.stories === 1 ? "story" : "stories"}
        </h3>
        <ul className="sp-headlines">
          {t.headlines.map((h) => (
            <li key={h.url}>
              <a href={h.url} target="_blank" rel="noopener noreferrer nofollow">
                {h.title}
              </a>
              <span className="muted">
                {h.outlet ? ` · ${h.outlet.replace(/^www\.|^feeds\./, "")}` : ""}
                {h.publishedAt ? ` · ${ago(h.publishedAt)}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <a className="sp-link" href={`/topics/${t.id}`}>
        Full details and charts →
      </a>
    </div>
  );
}
