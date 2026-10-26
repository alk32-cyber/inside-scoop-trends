export const LIFECYCLE_LABEL: Record<string, string> = {
  emerging: "Emerging",
  rising: "Rising",
  breakout: "Breakout",
  peaking: "Peaking",
  cooling: "Cooling",
  dormant: "Dormant",
  stable: "Stable",
  insufficient_data: "Not enough data",
};
export const LIFECYCLE_ICON: Record<string, string> = {
  emerging: "✦",
  rising: "↗",
  breakout: "⚡",
  peaking: "⛰",
  cooling: "↘",
  dormant: "◌",
  stable: "→",
  insufficient_data: "?",
};
export const SOURCE_LABEL: Record<string, string> = { youtube: "YouTube", reddit: "Reddit", news: "News", google_trends: "Google Trends" };
export const SOURCE_UNIT: Record<string, string> = {
  new_views: "new views per day",
  discussion: "new posts + comments per day",
  new_posts: "new stories per day (deduplicated)",
  search_interest: "search interest, 0–100 relative index",
};
export const COMPONENT_LABEL: Record<string, string> = {
  velocity: "Velocity (30%)",
  engagement: "Engagement momentum (25%)",
  crossPlatform: "Cross-platform (20%)",
  attention: "Attention (15%)",
  relevance: "Audience relevance (10%)",
};
export const FLAG_LABEL: Record<string, string> = {
  high_score_low_confidence: "High score, low confidence",
  low_confidence: "Low confidence",
  single_source: "Single source",
  stale_data: "Stale data",
  partial_components: "Partial data",
  single_underlying_story: "One underlying story",
};

export function utc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })} UTC`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 0) return "just now";
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}
