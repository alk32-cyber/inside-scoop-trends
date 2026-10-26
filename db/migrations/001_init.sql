-- Inside Scoop trend engine: initial schema (PostgreSQL 14+; also runs on PGlite).
-- All timestamps are stored as timestamptz and written in UTC.

CREATE TABLE IF NOT EXISTS topics (
  id                TEXT PRIMARY KEY,                 -- canonical topic id (stable slug)
  canonical_key     TEXT NOT NULL UNIQUE,             -- normalized grouping key
  name              TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'other',
  status            TEXT NOT NULL DEFAULT 'candidate'
                    CHECK (status IN ('candidate', 'active', 'merged', 'ignored')),
  merged_into       TEXT REFERENCES topics(id),
  origin            TEXT NOT NULL DEFAULT 'extracted' CHECK (origin IN ('config', 'extracted', 'demo')),
  embedding         JSONB,                            -- optional, only when an embedding provider is configured
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_demo           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topics_status_idx ON topics (status);
CREATE INDEX IF NOT EXISTS topics_category_idx ON topics (category);

CREATE TABLE IF NOT EXISTS topic_aliases (
  id          BIGSERIAL PRIMARY KEY,
  topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL,
  alias_key   TEXT NOT NULL UNIQUE,
  origin      TEXT NOT NULL DEFAULT 'extracted'
              CHECK (origin IN ('config', 'extracted', 'merge', 'manual', 'demo')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS topic_aliases_topic_idx ON topic_aliases (topic_id);

-- One row per piece of content seen at a provider (video, post, article).
CREATE TABLE IF NOT EXISTS source_items (
  id                 BIGSERIAL PRIMARY KEY,
  provider           TEXT NOT NULL,
  external_id        TEXT NOT NULL,
  url                TEXT NOT NULL,
  canonical_url      TEXT NOT NULL,
  story_key          TEXT NOT NULL,                  -- dedupe key for syndicated / copied stories
  content_type       TEXT NOT NULL,                  -- video | post | article
  title              TEXT NOT NULL,
  snippet            TEXT,
  author             TEXT,
  published_at       TIMESTAMPTZ,                    -- provider publication time, if supplied
  first_collected_at TIMESTAMPTZ NOT NULL,
  last_collected_at  TIMESTAMPTZ NOT NULL,
  latest_views       BIGINT,
  latest_likes       BIGINT,
  latest_comments    BIGINT,
  normalized_at      TIMESTAMPTZ,                    -- null until topic extraction has run
  meta               JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_demo            BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (provider, external_id)
);
CREATE INDEX IF NOT EXISTS source_items_provider_pub_idx ON source_items (provider, published_at);
CREATE INDEX IF NOT EXISTS source_items_story_idx ON source_items (story_key);
CREATE INDEX IF NOT EXISTS source_items_canonical_url_idx ON source_items (canonical_url);
CREATE INDEX IF NOT EXISTS source_items_unnormalized_idx ON source_items (normalized_at) WHERE normalized_at IS NULL;

-- Point-in-time engagement counters for an item. Deltas between snapshots
-- become new_views / new_likes / new_comments in observations.
CREATE TABLE IF NOT EXISTS item_metric_snapshots (
  item_id      BIGINT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  bucket_at    TIMESTAMPTZ NOT NULL,                 -- observed_at floored to the bucket size
  observed_at  TIMESTAMPTZ NOT NULL,
  views        BIGINT,
  likes        BIGINT,
  comments     BIGINT,
  source_rank  INTEGER,
  PRIMARY KEY (item_id, bucket_at)
);
CREATE INDEX IF NOT EXISTS item_metric_snapshots_bucket_idx ON item_metric_snapshots (bucket_at);

CREATE TABLE IF NOT EXISTS topic_source_links (
  topic_id        TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source_item_id  BIGINT NOT NULL REFERENCES source_items(id) ON DELETE CASCADE,
  match_method    TEXT NOT NULL,                     -- alias | extracted | config | embedding | demo
  matched_text    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (topic_id, source_item_id)
);
CREATE INDEX IF NOT EXISTS topic_source_links_item_idx ON topic_source_links (source_item_id);

-- Time series per topic, per source, per bucket. Only metrics a provider
-- actually supplies (or that are derivable from valid snapshots) are non-null.
CREATE TABLE IF NOT EXISTS observations (
  id               BIGSERIAL PRIMARY KEY,
  topic_id         TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL,             -- bucket start (UTC)
  collected_at     TIMESTAMPTZ NOT NULL,             -- when this row was computed/collected
  published_at     TIMESTAMPTZ,                      -- latest provider publication time among contributing items
  search_interest  DOUBLE PRECISION,                 -- normalized 0-100 (Google Trends); NOT absolute volume
  new_posts        INTEGER,
  new_views        BIGINT,
  new_likes        BIGINT,
  new_comments     BIGINT,
  engagement_rate  DOUBLE PRECISION,
  source_rank      INTEGER,
  sample_size      INTEGER NOT NULL DEFAULT 0,       -- number of items behind this row
  unique_stories   INTEGER,                          -- distinct story_keys behind this row
  data_quality     DOUBLE PRECISION NOT NULL DEFAULT 1 CHECK (data_quality >= 0 AND data_quality <= 1),
  source_url       TEXT,
  is_demo          BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (topic_id, source, observed_at)
);
CREATE INDEX IF NOT EXISTS observations_topic_time_idx ON observations (topic_id, observed_at);
CREATE INDEX IF NOT EXISTS observations_source_time_idx ON observations (source, observed_at);

CREATE TABLE IF NOT EXISTS trend_scores (
  topic_id              TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
  computed_at           TIMESTAMPTZ NOT NULL,
  as_of                 TIMESTAMPTZ NOT NULL,
  window_hours          INTEGER NOT NULL,
  trend_score           DOUBLE PRECISION NOT NULL CHECK (trend_score >= 0 AND trend_score <= 100),
  velocity_score        DOUBLE PRECISION,
  engagement_score      DOUBLE PRECISION,
  cross_platform_score  DOUBLE PRECISION,
  attention_score       DOUBLE PRECISION,
  relevance_score       DOUBLE PRECISION,
  confidence            DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  lifecycle             TEXT NOT NULL,
  score_change_24h      DOUBLE PRECISION,
  missing_components    TEXT[] NOT NULL DEFAULT '{}',
  flags                 TEXT[] NOT NULL DEFAULT '{}',
  sources               TEXT[] NOT NULL DEFAULT '{}',
  details               JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_demo               BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS trend_scores_score_idx ON trend_scores (trend_score DESC);
CREATE INDEX IF NOT EXISTS trend_scores_lifecycle_idx ON trend_scores (lifecycle);
CREATE INDEX IF NOT EXISTS trend_scores_confidence_idx ON trend_scores (confidence);

CREATE TABLE IF NOT EXISTS trend_score_history (
  id            BIGSERIAL PRIMARY KEY,
  topic_id      TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  as_of         TIMESTAMPTZ NOT NULL,
  computed_at   TIMESTAMPTZ NOT NULL,
  trend_score   DOUBLE PRECISION NOT NULL,
  confidence    DOUBLE PRECISION NOT NULL,
  lifecycle     TEXT NOT NULL,
  components    JSONB NOT NULL,
  is_demo       BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (topic_id, as_of)
);
CREATE INDEX IF NOT EXISTS trend_score_history_topic_time_idx ON trend_score_history (topic_id, as_of);
CREATE INDEX IF NOT EXISTS trend_score_history_lifecycle_idx ON trend_score_history (lifecycle);

CREATE TABLE IF NOT EXISTS content_recommendations (
  id                  BIGSERIAL PRIMARY KEY,
  topic_id            TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  generated_at        TIMESTAMPTZ NOT NULL,
  data_timestamp      TIMESTAMPTZ NOT NULL,           -- newest observation the analysis is based on
  method              TEXT NOT NULL CHECK (method IN ('llm', 'template')),
  model               TEXT,
  evidence_sufficient BOOLEAN NOT NULL,
  evidence_item_ids   BIGINT[] NOT NULL DEFAULT '{}',
  payload             JSONB NOT NULL,
  is_demo             BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (topic_id, data_timestamp, method)
);
CREATE INDEX IF NOT EXISTS content_recommendations_topic_idx ON content_recommendations (topic_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id                    BIGSERIAL PRIMARY KEY,
  provider              TEXT NOT NULL,
  job                   TEXT NOT NULL,                -- ingest | normalize | score | analyze | demo_seed
  started_at            TIMESTAMPTZ NOT NULL,
  finished_at           TIMESTAMPTZ,
  status                TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'failed', 'skipped')),
  items_fetched         INTEGER NOT NULL DEFAULT 0,
  items_new             INTEGER NOT NULL DEFAULT 0,
  observations_written  INTEGER NOT NULL DEFAULT 0,
  requests_made         INTEGER NOT NULL DEFAULT 0,
  newest_item_at        TIMESTAMPTZ,                  -- freshest provider publication time seen in this run
  error_message         TEXT,
  details               JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_demo               BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS ingestion_runs_provider_time_idx ON ingestion_runs (provider, started_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_runs_status_idx ON ingestion_runs (status);
