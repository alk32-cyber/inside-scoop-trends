/**
 * HTTP client for provider adapters: exponential backoff with jitter on
 * transient failures, Retry-After support, per-run request budget, a
 * minimum interval between requests, and secret redaction in errors.
 */

export class BudgetExceededError extends Error {
  constructor(provider: string, budget: number) {
    super(`${provider}: request budget of ${budget} for this run is exhausted`);
    this.name = "BudgetExceededError";
  }
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface HttpClientOptions {
  provider: string;
  /** Maximum requests this run may make (derived from the provider's daily budget). */
  budget: number;
  /** Minimum milliseconds between consecutive requests (simple rate limiting). */
  minIntervalMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Values that must never appear in logs or stored error messages. */
  secrets?: Array<string | undefined>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  requests = 0;
  private lastRequestAt = 0;
  private readonly opts: Required<Omit<HttpClientOptions, "secrets" | "userAgent">> & Pick<HttpClientOptions, "secrets" | "userAgent">;

  constructor(opts: HttpClientOptions) {
    this.opts = {
      minIntervalMs: 0,
      maxRetries: 4,
      baseDelayMs: 1000,
      timeoutMs: 20_000,
      fetchImpl: globalThis.fetch.bind(globalThis),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  /** Replaces configured secrets (and common key/token query params) with [redacted]. */
  redact(text: string): string {
    let out = text.replace(/([?&](key|api_key|apikey|token|access_token|client_secret)=)[^&\s]+/gi, "$1[redacted]");
    for (const s of this.opts.secrets ?? []) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
    return out;
  }

  async json<T = unknown>(url: string, init: RequestOptions = {}): Promise<T> {
    const res = await this.request(url, init);
    return (await res.json()) as T;
  }

  async text(url: string, init: RequestOptions = {}): Promise<string> {
    const res = await this.request(url, init);
    return res.text();
  }

  async request(url: string, init: RequestOptions = {}): Promise<Response> {
    let attempt = 0;
    for (;;) {
      if (this.requests >= this.opts.budget) throw new BudgetExceededError(this.opts.provider, this.opts.budget);
      const wait = this.lastRequestAt + this.opts.minIntervalMs - Date.now();
      if (wait > 0) await this.opts.sleep(wait);
      this.lastRequestAt = Date.now();
      this.requests++;

      let res: Response | null = null;
      let networkError: unknown = null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      try {
        res = await this.opts.fetchImpl(url, {
          method: init.method ?? "GET",
          headers: { Accept: "application/json", ...(this.opts.userAgent ? { "User-Agent": this.opts.userAgent } : {}), ...init.headers },
          body: init.body,
          signal: controller.signal,
        });
      } catch (err) {
        networkError = err;
      } finally {
        clearTimeout(timer);
      }

      if (res && res.ok) return res;

      const status = res?.status ?? null;
      const retryable = networkError !== null || (status !== null && RETRYABLE.has(status));
      if (!retryable || attempt >= this.opts.maxRetries) {
        let detail = "";
        if (res) {
          try {
            detail = (await res.text()).slice(0, 300);
          } catch {
            /* body unavailable */
          }
        }
        const reason = networkError ? `network error: ${(networkError as Error).message}` : `HTTP ${status}`;
        throw new ProviderHttpError(this.redact(`${this.opts.provider} ${reason} for ${url}${detail ? ` — ${detail}` : ""}`), status, retryable);
      }

      const retryAfter = res?.headers.get("retry-after");
      const retryAfterMs = retryAfter ? (Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
      const backoff = this.opts.baseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5);
      await this.opts.sleep(Math.min(60_000, Math.max(backoff, retryAfterMs)));
      attempt++;
    }
  }
}
