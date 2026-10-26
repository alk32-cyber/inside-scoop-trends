import type { HttpClient } from "./http";

/** One piece of content as returned by a provider, before normalization. */
export interface RawItem {
  externalId: string;
  url: string;
  /** Outbound link for link posts / aggregators: used to recognise the same story across platforms. */
  linkedUrl?: string | null;
  contentType: "video" | "post" | "article";
  title: string;
  snippet?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  /** Cumulative counters at collection time, only when the provider supplies them. */
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  /** Position in the provider's listing/search results. */
  rank?: number | null;
  meta?: Record<string, unknown>;
}

/** A normalized search-interest series for a topic (Google Trends). Values are relative 0-100, not volumes. */
export interface InterestSeries {
  topicId: string;
  query: string;
  sourceUrl: string;
  points: Array<{ time: Date; value: number; partial: boolean }>;
}

export interface CollectResult {
  items: RawItem[];
  interest?: InterestSeries[];
  /** Items the provider reports as removed/deleted; the pipeline purges their stored text. */
  removedExternalIds?: string[];
  warnings: string[];
}

export interface ProviderContext {
  now: Date;
  http: HttpClient;
  env: Record<string, string | undefined>;
  /** External ids of items this provider collected recently, for counter refreshes. */
  trackedExternalIds(sinceDays: number): Promise<string[]>;
  /** Topics to query for search interest (highest-ranked active topics first). */
  topicsForInterest(limit: number): Promise<Array<{ topicId: string; query: string }>>;
}

export interface ConfigStatus {
  configured: boolean;
  missing: string[];
  notes?: string;
}

export interface ProviderAdapter {
  readonly name: "youtube" | "reddit" | "news" | "google_trends";
  readonly label: string;
  readonly attribution: string;
  readonly docsUrl: string;
  configStatus(env: Record<string, string | undefined>): ConfigStatus;
  /** Secrets to redact from logs. */
  secrets(env: Record<string, string | undefined>): Array<string | undefined>;
  userAgent?(env: Record<string, string | undefined>): string;
  minIntervalMs?: number;
  collect(ctx: ProviderContext): Promise<CollectResult>;
  /** Cheapest request that proves the credentials work. */
  check(ctx: ProviderContext): Promise<string>;
}
