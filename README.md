# Inside Scoop — Trending Topic Intelligence

> **Homepage = Topic Finder.** Topics are ranked best → worst by a **Pod Score** (`src/lib/pod.ts`):
> teen appeal 40% (lanes in `config/teen.json`: creators, gaming, money, AI & apps, brands, music/sports, startups) +
> coverage 25% (distinct stories and outlets, last 72h) + buzz 20% (the trend score below) + freshness 15%.
> Heavy news (war, lawsuits, politics) is pushed down and labelled; single-story topics never rank above "Maybe".
> Each card shows the real headline, why it's a good pick and three questions to ask on the mic.
> The numbers-first dashboard lives at `/advanced`; the API is `GET /api/topics?lane=&sort=best|newest|rising`.

A trend discovery and ranking engine for **Inside Scoop**, a Gen Z entrepreneurship and business podcast. It collects signals from YouTube, Reddit, news and Google Trends, groups them into canonical topics, measures how attention **changes over time**, explains what is driving it (from the evidence only), and suggests episode angles.

It ranks topics by measured momentum, not by a static list of popular subjects. A big but flat topic loses to a smaller one that is accelerating across independent platforms.

```
providers ──► source_items + item_metric_snapshots ──► normalize (topics, aliases, links)
 (YouTube, Reddit,          │                                   │
  News, Trends)             ▼                                   ▼
                    observations (hourly, per topic × source) ──► scoring engine ──► trend_scores (+ history)
                                                                                      │
                                                        content_recommendations ◄─────┤
                                                                                      ▼
                                                                    REST API ──► dashboard
```

**Format:** a web dashboard (Next.js, deployable to Vercel like the other projects), not a phone app. A host checks it before planning an episode; the ingestion runs in the background on a schedule. It works on a phone browser and can be added to the home screen later if needed.

---

## Quick start

Requires Node 20+.

```bash
npm install
cp .env.example .env.local          # fill in what you have; everything is optional for a first look

# 1) Look at the dashboard with SIMULATED data (clearly labelled as demo everywhere)
npm run demo:seed
DEMO_MODE=true npm run dev            # http://localhost:3000

# 2) Live data: add provider credentials (see "Provider setup"), then
npm run providers:check               # proves each configured credential works
npm run ingest -- --force             # collect → normalize → derive → score → analyze
npm run dev                           # DEMO_MODE=false shows live data only
```

**Storage modes** (picked automatically, see `storageMode()` in `src/lib/db/index.ts`):

| Mode | When | Notes |
|---|---|---|
| Postgres | `DATABASE_URL` set | Recommended for production (Neon, Supabase, etc.) |
| Vercel Blob | on Vercel, no `DATABASE_URL`, `BLOB_READ_WRITE_TOKEN` set (connect a Blob store to the project) | The live database is an in-memory copy loaded from a private Blob snapshot; each scheduled run reloads it, collects, scores and saves it back (ETag-guarded). Rows older than 10–30 days are pruned. Fine for one show's dashboard; move to Postgres if data grows. |
| In-memory | on Vercel with neither | Demo only; live ingestion refuses to run |
| Local PGlite | anywhere else | Files in `./.data/pglite` |

Without `DATABASE_URL` locally, an embedded Postgres (PGlite) is stored in `./.data/pglite`. Set `DATABASE_URL` to use any Postgres 14+ (required on Vercel, whose filesystem is not persistent). Migrations run automatically on first connection, or explicitly with `npm run db:migrate`.

| Command | What it does |
|---|---|
| `npm run ingest [-- --force] [-- --provider=reddit,news] [-- --no-analyze]` | One pipeline run (only due providers unless `--force`) |
| `npm run scheduler` | Long-running scheduler for self-hosting (per-provider intervals) |
| `npm run score [-- --demo]` | Re-score without collecting (e.g. after changing weights) |
| `npm run providers:check` | Minimal authenticated request to each configured provider |
| `npm run backtest [-- --demo] [-- --step=6 --horizon=24 --k=5]` | Backtest + train/test weight search |
| `npm run demo:seed` / `npm run demo:clear` | Create / delete simulated data (`is_demo = true` rows only) |
| `npm test` | Unit + integration tests (in-memory Postgres) |

---

## How the score works

Every topic gets a **trend score (0–100)** and, separately, a **confidence score (0–100)**. Both are always shown; they are never blended.

```
trend_score = 0.30 · velocity + 0.25 · engagement_momentum + 0.20 · cross_platform
            + 0.15 · attention + 0.10 · audience_relevance
```

Each component is normalized to 0–100 first. Weights are configurable (`SCORING_WEIGHTS`, renormalized to sum to 1) and can be tuned with the backtest.

### Windows

Time is cut into equivalent windows ending at the scoring time: the **recent window** (default 24h) and **6 earlier windows of the same length** that form the topic's own baseline. Observations are stored in hourly buckets (UTC), so windows line up across sources.

Each source has one **volume metric**. Raw counts from different platforms are never compared with each other:

| Source | Volume metric | Engagement metric |
|---|---|---|
| YouTube | new views (Δ between snapshots) | new likes + comments, and interactions per view |
| Reddit | new posts + new comments | new upvotes + comments |
| News | new **stories** (syndicated copies counted once) | — |
| Google Trends | mean normalized search interest (0–100 index) | — |

### 1. Velocity (30%)

Per source:

- **Log growth**: `g = ln((R + α) / (B + α))`, where `R` is the recent-window volume, `B` is the mean of the baseline windows, and `α` is a per-source smoothing pseudo-count (2 stories, 2,000 views, 15 Reddit interactions, 5 interest points). The smoothing stops tiny denominators from producing huge breakouts: going from 0 to 3 posts is not a 300× spike.
- **Mapping**: `50 + 50·tanh(g / ln 4)`. Flat activity scores 50, doubling about 73, 4× about 88, and halving about 27.
- **Self-baseline z-score** (when there are ≥3 baseline windows): `(R − B) / max(sd, √(B+α))` is blended in at 30%. It answers "is this unusual *for this topic*?"
- **Acceleration** (when there are ≥2 earlier windows): the change in growth rate between consecutive windows adjusts the score by up to ±8.
- **Minimum sample**: below each source's minimum (for example 3 items, or 6 Trends points), velocity is *unavailable* for that source rather than guessed.

Per-source values are combined using each source's reliability weight.

### 2. Engagement momentum (25%)

New interactions per hour in the recent window, compared with the **same topic's** earlier windows on the **same source and content type**. For YouTube, the change in interactions per view is blended in at 30%. Sources without engagement data (news, Trends) don't contribute; they are not counted as zero.

### 3. Cross-platform confirmation (20%)

This counts independent platforms whose velocity shows growth (≥ +25%). Independence is checked at the story level:

- Every item has a **story key**. It is the canonical URL (tracking parameters stripped) for articles and for link posts that point to them. A headline fingerprint (≥80% token overlap) catches syndicated copies at other URLs.
- Platforms are visited in a fixed order. A story already credited to one platform cannot confirm the trend again on another, so a Reddit thread that links the same article is not a second confirmation.
- The score steps 0 → 35 → 70 → 90 → 100 for 0 → 4+ independent platforms. It is halved when all the growing signals trace back to one underlying story, and the topic is flagged `single_underlying_story`.
- A single confirming source also lowers confidence and sets the `single_source` flag.

### 4. Attention (15%)

This is the current level compared with other topics on the same source: a percentile rank of recent volume (log-scaled when fewer than 5 topics are present). It is **damped by velocity** (×0.4–1.0), so a huge but stagnant topic can't dominate the ranking just by being big. The dashboard's "Most discussed" view ranks by raw attention for when that's what you want.

### 5. Audience relevance (10%)

This is the fit with the show, from `config/categories.json`: entrepreneurship, startups, business strategy, technology, marketing, finance education, leadership, negotiation and Gen Z culture, each with an editable weight and keywords. It is an **editorial estimate, not observed demand**. A topic needs at least one *observed* component to score above 0, so relevance alone can never make something "trend".

### Missing data

A missing component is never treated as zero:

- It is recorded in `missing_components` and shown as "not available — reweighted".
- The available components are reweighted proportionally, but only fully when at least 55% of the formula's weight is measured. Below that, the score shrinks linearly toward 0, so attention plus relevance with no measured growth can't produce a high score.
- A provider that collected successfully but found nothing for a topic is a **measured zero**. A provider that didn't collect is **missing**. Successful runs in `ingestion_runs` are what tell the two apart.
- Confidence is reduced through its completeness input.

### Lifecycle

This needs ≥3 windows with data and at least one source with a valid velocity; otherwise the topic is `insufficient_data`. Lifecycle is decided from the *shape* of the series, never from the score:

| Label | Rule (evaluated in order) |
|---|---|
| Dormant | current activity ≤ 10% of its own observed peak |
| Peaking | still ≥ +25% over baseline and ≥ 80% of peak, but window-over-window growth < 10% and decelerating |
| Emerging | growing ≥ 25%, and first seen < 3 windows ago or from a near-zero baseline |
| Breakout | ≥ 3× baseline **and** ≥ 2 independent sources |
| Rising | ≥ +25% vs baseline |
| Cooling | ≤ −20% vs baseline |
| Stable | otherwise (added because "none of the above" needs a name) |

Every scoring run writes `trend_score_history`, which powers the trajectory chart and the 24h score change.

### Confidence (separate from the score)

`confidence = 100 × (0.25·sources + 0.20·sample + 0.20·freshness + 0.15·consistency + 0.20·completeness)`

| Input | Meaning |
|---|---|
| sources | independent platforms with valid growth data ÷ 3 (capped at 1) |
| sample | `1 − e^(−items/25)` |
| freshness | `e^(−age / staleAfter)` of the newest **collected** data per source (6–24h by source) |
| consistency | agreement on growth direction across sources (single source = 0.5) |
| completeness | measured share of the formula × average data quality (e.g. Google's partial last point = 0.5) |

`high_score_low_confidence` is flagged when score ≥ 60 and confidence < 40, and it is shown prominently in the UI.

---

## Topic normalization

1. **Curated topics** (`config/topics.json`) match by alias after normalization, which folds case, punctuation, plurals, "4-day" → "four day", "Tik Tok" → "tiktok", and so on. Ambiguous names use `requireContext` (e.g. "Meta" only matches with a company context word). `doNotMergeWith` prevents merges between look-alikes (TikTok Shop vs TikTok ban, Apple Pay vs Apple Vision Pro).
2. **Extracted topics**: candidate phrases come from titles. These are proper-noun runs plus 1–3-word n-grams, with stopwords, headline filler and modifiers ("explained", "update", "launch") removed. A phrase becomes a topic only with **distinct-story support**: ≥2 stories for proper nouns, ≥3 for other phrases. Lowercase single words never become topics, and neither do words inside a curated mention. A sub-phrase with the same support as a longer phrase is dropped in favour of the specific one.
3. **Semantic merging (optional)**: with `VOYAGE_API_KEY`, topics are embedded and merged when cosine ≥ 0.9, the category matches, the words overlap (Jaccard ≥ 0.5), and no `doNotMergeWith` rule applies. Without the key, only the deterministic rules run.
4. Every topic keeps its aliases and links (`topic_source_links`) to the original items, which is the evidence behind it.

Duplicates can't inflate counts. Items are unique per `(provider, external_id)`, snapshots per `(item, hour)`, and observations per `(topic, source, hour)`. Stories are counted once, in the bucket where the first copy appeared.

---

## AI analysis (evidence only)

For the top topics (re-generated only when new data arrives), `src/lib/analysis/generate.ts` sends Claude (`claude-opus-5-5` by default) the computed metrics and the linked evidence (titles, snippets, URLs, timestamps). The response is **structured JSON validated with Zod** (`src/lib/analysis/schema.ts`), with these fields:

- description, evidence-based `why_rising`, strongest signals, recent developments
- `confirmed_facts` (each must cite evidence URLs) vs `potential_explanations` (clearly unconfirmed)
- 3 content angles, interview questions, case-study questions, source links, data timestamp

**Post-validation** in code:

- URLs not in the evidence set are removed.
- Facts left with no citation are dropped.
- Numbers that don't appear in the inputs are flagged in the UI.
- If no fact survives, the analysis says *"The reason for this trend cannot yet be confirmed."*

The model is never called for demo data, fewer than 3 evidence items, or confidence < 30. In those cases a deterministic **template** analysis is stored and labelled as such. The request uses server-side refusal fallbacks (`fallbacks: "default"`), and a refusal or API error also falls back to the template.

---

## API

All endpoints return JSON with UTC ISO timestamps. Inputs are validated with Zod, and errors use the shape `{ error: { code, message, details } }`. Responses are cached for 30 seconds in memory plus `Cache-Control: private`.

| Endpoint | Description |
|---|---|
| `GET /api/trends` | Ranked topics. Query: `view` (`all`, `opportunities`, `emerging`, `breakout`, `momentum`, `most_discussed`, `cooling`), `category`, `source`, `lifecycle` (comma lists), `minConfidence`, `window` (`24h`, `72h`, `7d`) or `from`/`to`, `limit` (≤100), `offset` |
| `GET /api/trends/:id` | Metadata, score breakdown (per source), score history, activity chart data, evidence, analysis |
| `GET /api/trends/:id/sources` | Supporting source items (`limit`, `offset`) |
| `GET /api/trends/:id/content-ideas` | Latest evidence-grounded analysis and angles |
| `GET /api/system/status` | Per-provider configuration, connection state, last success, freshness, errors, request budget use |
| `GET /api/cron/ingest` | Scheduled pipeline run; requires `Authorization: Bearer $CRON_SECRET` |

**Access control:** set `DASHBOARD_PASSWORD` to require HTTP Basic auth on every page and API route. API routes are rate-limited per IP (`API_RATE_LIMIT_PER_MINUTE`). No secret is ever sent to the browser.

---

## Provider setup

A provider is reported as **connected only after a successful collection is recorded**. With credentials set but no successful run yet, it shows "configured — not yet tested". `npm run providers:check` makes one cheap authenticated request per provider.

### YouTube Data API v3 — `YOUTUBE_API_KEY`
1. In Google Cloud Console, create a project and enable **YouTube Data API v3**.
2. Go to APIs & Services → Credentials → Create credentials → API key. Restrict it to the YouTube Data API.
3. Quota: the default is 10,000 units/day. `search.list` costs 100 units and `videos.list` costs 1 per 50 videos. The defaults (8 queries every 3h, plus stats refresh for tracked videos) use roughly 6,500 units/day. Edit queries in `config/sources.json`.
4. Terms: comply with the YouTube API Services Terms; the "Data from YouTube" attribution is shown on the status page.

### Reddit Data API — `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT`
1. At https://www.reddit.com/prefs/apps, create an app ("script" type works for server use) and copy the id and secret.
2. Set a descriptive user agent: `web:inside-scoop-trends:0.1.0 (by /u/yourname)`.
3. Uses the OAuth client-credentials flow, staying under 100 requests/minute. **Commercial use requires Reddit's approval** under its Data API terms; check before going live.
4. Data handling: only titles, short snippets and public counters are stored. Posts later reported as removed or deleted have their stored text purged on the next refresh.

### News — `NEWSAPI_KEY` and/or RSS feeds
By default, public publisher RSS feeds (TechCrunch Startups, Entrepreneur, Fast Company, NPR Business, CNBC Small Business, Crunchbase News, The Verge) are collected with no key. Edit `config/sources.json` → `news.rssFeeds`, or add more with `NEWS_RSS_FEEDS`. On a once-a-day schedule, set `NEWS_STALE_AFTER_HOURS=30` and `STALE_AFTER_HOURS=30` so daily data isn't flagged stale.

- **NewsAPI.org**: get a key at https://newsapi.org. The free Developer plan is for development only and delays articles, so production needs a paid plan. Queries are in `config/sources.json`.
- **RSS**: add comma-separated feed URLs you're allowed to use (check each publisher's terms). Only headline, link, time and a short description are stored.

### Google Trends — `SERPAPI_KEY`
Google has no generally available public Trends API. This build uses SerpApi's Google Trends engine (https://serpapi.com/google-trends-api), a paid, documented service. Each run queries the top active topics, 1 search per topic (10 every 6h by default; set `GOOGLE_TRENDS_DAILY_REQUEST_BUDGET` to match your plan). If you get access to Google's official Trends API (alpha), implement another adapter returning the same `InterestSeries`. Values are relative 0–100 indices and are **never treated as search volume**. Each run replaces the stored timeframe, because Google re-normalizes the series.

### Optional
- `ANTHROPIC_API_KEY`: AI analysis (see above). Without it, template summaries are used.
- `VOYAGE_API_KEY`: embedding-based topic merging. Without it, deterministic grouping only.

---

## Scheduling and deployment

- **Vercel**: set `DATABASE_URL` (Neon, Supabase or Vercel Postgres), `CRON_SECRET` and the provider keys. `vercel.json` calls `/api/cron/ingest` once a day (06:00 UTC), which works on every plan; each call runs the providers that are due under their own interval and daily budget. For fresher data, raise the cron frequency if your Vercel plan allows it (check the Cron Jobs usage docs), or have any external scheduler (for example a GitHub Actions cron) call the endpoint with the Bearer secret. Without `DATABASE_URL` the route refuses to run, because collected data would not persist. Deployments without a database can still show the bundled demo (`DEMO_MODE=true`, loaded from `demo/demo-snapshot.json.gz` and rebuilt with `npm run demo:snapshot`).
- **Self-hosted**: run `npm run scheduler` (ticks every `SCHEDULER_TICK_MINUTES`) next to `npm start`.
- **Reliability**:
  - Transient errors (408/429/5xx/network) are retried with exponential backoff and jitter, honouring `Retry-After`.
  - Every run is recorded in `ingestion_runs` with status, request count, newest item time and redacted errors.
  - Daily request budgets are enforced from those records.
  - One failing provider never stops the others.
  - Data is labelled stale (not live) once it exceeds `STALE_AFTER_HOURS`, and banners name the provider.

---

## Backtesting

`npm run backtest` replays history. At each cutoff it scores topics using **only data observed and collected by that time**. It then measures whether each topic gained attention over the next horizon (default 24h): the log change of volume in the following window vs the preceding one, per source. The report includes:

- **Spearman** correlation between score and subsequent gain
- **precision@K**: the share of the top-K that gained
- a **popularity baseline**: the same precision when ranking by current attention only
- a **weight search** on a 0.05 grid, tuned on the earliest 70% of cutoffs and judged on the latest 30%; it recommends new `SCORING_WEIGHTS` only if they beat the defaults out of sample

It writes a JSON report to `.data/`. It never changes the live configuration. Wait for a few weeks of live data before trusting tuned weights. On demo data, the backtest only shows that the procedure works.

---

## Tests

`npm test` runs 44 tests, including:

- An accelerating topic outranks a similar stagnant one.
- A popular but declining topic doesn't rank first (and is labelled cooling).
- A tiny sample can't produce a breakout (velocity is unavailable below the minimum sample; smoothing caps small jumps).
- A duplicated story doesn't inflate cross-platform confirmation; syndicated copies count once in storage.
- A missing provider is reweighted and recorded, not zeroed; a measured zero is distinguished from missing data.
- Old data lowers freshness and confidence and raises a stale flag.
- Similar keywords group together (plurals, punctuation, aliases), unrelated look-alikes stay apart, and ambiguous names need context.
- Scores and components stay within 0–100; rankings are deterministic, including tie-breaks.
- The HTTP client: retry/backoff, `Retry-After`, request budget, secret redaction.
- AI guardrails: uncited facts and unknown URLs are removed, invented numbers are flagged, and template fallbacks are used.
- Pipeline integration on in-memory Postgres: idempotent storage and derivation, failed and skipped runs, a provider never claimed as connected without a recorded success, demo and live separation.
- The backtest on saved observations.

---

## Limitations

- **Survivorship in backtests**: topics come from today's topic table, filtered to those first seen before each cutoff. Extraction itself isn't replayed historically.
- **Engagement is sampled, not streamed**: view and like deltas exist only between our snapshots. Items first seen more than 24h after publication contribute no delta for that first snapshot, because we can't tell when those views happened.
- **Reddit** exposes no view counts, so Reddit attention is posts + comments.
- **NewsAPI free tier** results are delayed and limited to development use.
- **Google Trends via SerpApi** returns values relative to each query's own timeframe. Comparisons are within a topic's own series, never across topics on an absolute scale.
- **Topic extraction is English-only** and works from titles. Without embeddings, synonyms that share no words (for example "layoffs" vs "job cuts") stay separate unless added as aliases in `config/topics.json`.
- **Rate limiting is per server instance** (best effort); add an edge or WAF rule for stronger protection.
- **Design**: the original Inside Scoop site wasn't reachable while this was built, so the dashboard uses a neutral design. All colors are CSS tokens at the top of `src/app/globals.css`; change the `--brand*` and surface tokens to match the show's branding.

---

## Status: operational vs awaiting credentials

| Feature | State |
|---|---|
| Database schema, migrations, idempotent upserts, indexes | **Operational** (tested on PGlite; same SQL for Postgres) |
| Normalization, grouping, dedupe, story keys | **Operational** (deterministic) |
| Scoring, lifecycle, confidence, history, 24h change | **Operational** |
| REST API with validation, pagination, caching, auth, rate limits | **Operational** |
| Dashboard (views, filters, breakdown, charts, evidence, status page) | **Operational** (verified with demo data) |
| Demo mode (simulated, labelled) | **Operational** |
| Backtest and weight search | **Operational** (verified on demo and synthetic data) |
| Scheduling: Vercel cron route, self-hosted scheduler, budgets, retries | **Operational** (code paths tested; not deployed) |
| YouTube adapter | **Awaiting credentials** (`YOUTUBE_API_KEY`); not tested against the live API |
| Reddit adapter | **Awaiting credentials and Reddit approval for commercial use**; not tested live |
| News adapter (NewsAPI / RSS) | **Keyless RSS enabled by default** (7 publisher feeds in `config/sources.json`); parser unit-tested; feeds verified only once the first deployed run succeeds. NewsAPI awaits `NEWSAPI_KEY` |
| Google Trends adapter (SerpApi) | **Awaiting credentials** (`SERPAPI_KEY`); not tested live |
| AI analysis with Claude | **Awaiting `ANTHROPIC_API_KEY`**; request/validation path tested with a mocked client; templates used until then |
| Embedding-based merging (Voyage) | **Optional, awaiting `VOYAGE_API_KEY`**; not tested live |

---

## Project layout

```
config/            categories (audience relevance), curated topics/aliases, provider queries
db/migrations/     SQL schema
src/lib/providers/ adapters (YouTube, Reddit, News/RSS, Google Trends) + HTTP client
src/lib/normalize/ text normalization, extraction, grouping, dedupe, embeddings
src/lib/scoring/   pure scoring engine (velocity, engagement, cross-platform, attention, lifecycle, confidence)
src/lib/pipeline/  ingest → normalize → derive observations → score → analyze
src/lib/analysis/  Claude structured analysis + guardrails + templates
src/lib/api/       query layer used by the route handlers
src/lib/demo/      simulated data generator
src/app/           dashboard pages and API routes
scripts/           CLI entry points
tests/             vitest suites
```
