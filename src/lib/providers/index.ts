import { googleTrendsAdapter } from "./googleTrends";
import { newsAdapter } from "./news";
import { redditAdapter } from "./reddit";
import type { ProviderAdapter } from "./types";
import { youtubeAdapter } from "./youtube";

export const providers: ProviderAdapter[] = [youtubeAdapter, redditAdapter, newsAdapter, googleTrendsAdapter];

export function getProvider(name: string): ProviderAdapter | undefined {
  return providers.find((p) => p.name === name);
}
