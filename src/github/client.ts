// GitHub REST client tuned for a dashboard that re-reads the same resources
// all day.
//
// Request budget strategy, cheapest first:
//   1. fresh cache   - served from memory inside `freshMs`, no network at all
//   2. coalesced     - an identical request already in flight is awaited, not repeated
//   3. revalidated   - conditional GET with If-None-Match; an authorized 304
//                      does not count against the primary rate limit
//   4. network       - full 200 response, cached with its ETag for next time
//   5. stale         - upstream failed after retries; serve the last good copy
//
// Errors are classified (not-found, auth, forbidden, rate-limited,
// unavailable) so the API layer can map them to precise HTTP statuses and a
// Retry-After the caller can act on.

import { parseLinkHeader, type LinkMap } from "./link.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const GITHUB_API_VERSION = "2026-03-10";

export interface GitHubClientOptions {
  fetch: FetchLike;
  token?: string | undefined;
  userAgent: string;
  baseUrl?: string;
  apiVersion?: string;
  freshMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RateState {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  resetAt: string | null;
  resource: string | null;
}

export interface UpstreamStats {
  requests: number;
  fresh: number;
  coalesced: number;
  revalidated: number;
  network: number;
  stale: number;
  retries: number;
  errors: number;
}

export type ResultSource = "fresh" | "revalidated" | "network" | "stale";

export interface GetResult<T> {
  data: T;
  link: LinkMap;
  source: ResultSource;
}

export type UpstreamErrorKind = "not-found" | "auth" | "forbidden" | "rate-limited" | "unavailable" | "bad-response";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status: number | null;
  readonly retryAfterSec: number | null;
  constructor(kind: UpstreamErrorKind, message: string, status: number | null, retryAfterSec: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

interface CacheEntry {
  etag: string | null;
  lastModified: string | null;
  data: unknown;
  link: LinkMap;
  storedAt: number;
}

export interface GetOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip the fresh window and revalidate with the origin (client sent Cache-Control: no-cache). */
  revalidate?: boolean;
}

export class GitHubClient {
  readonly apiVersion: string;
  readonly rate: RateState = { limit: null, remaining: null, used: null, resetAt: null, resource: null };
  readonly stats: UpstreamStats = { requests: 0, fresh: 0, coalesced: 0, revalidated: 0, network: 0, stale: 0, retries: 0, errors: 0 };

  private readonly fetchImpl: FetchLike;
  private readonly token: string | undefined;
  private readonly userAgent: string;
  private readonly base: URL;
  private readonly freshMs: number;
  private readonly maxEntries: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<GetResult<unknown>>>();

  constructor(options: GitHubClientOptions) {
    this.fetchImpl = options.fetch;
    this.token = options.token;
    this.userAgent = options.userAgent;
    this.base = new URL(options.baseUrl ?? "https://api.github.com");
    this.apiVersion = options.apiVersion ?? GITHUB_API_VERSION;
    this.freshMs = options.freshMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 2_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Resolves a path or a pagination URL. Absolute URLs must share the API
   * origin: a Link header is upstream-controlled input, and following it to
   * another host would forward the bearer token there.
   */
  resolve(pathOrUrl: string, query?: GetOptions["query"]): string {
    const url = pathOrUrl.startsWith("/") ? new URL(pathOrUrl, this.base) : new URL(pathOrUrl);
    if (url.origin !== this.base.origin) {
      throw new UpstreamError("bad-response", `refusing to follow a URL outside ${this.base.origin}`, null);
    }
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  async get<T>(pathOrUrl: string, options: GetOptions = {}): Promise<GetResult<T>> {
    const key = this.resolve(pathOrUrl, options.query);
    this.stats.requests++;
    const cached = this.cache.get(key);
    if (cached && !options.revalidate && this.now() - cached.storedAt < this.freshMs) {
      this.stats.fresh++;
      return { data: cached.data as T, link: cached.link, source: "fresh" };
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending as Promise<GetResult<T>>;
    }
    const task = this.fetchWithRetry(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task as Promise<GetResult<T>>;
  }

  /** Follows rel="next" links up to `maxPages`; reports whether it stopped early. */
  async paginate<T>(path: string, options: GetOptions & { maxPages?: number } = {}): Promise<{ items: T[]; truncated: boolean }> {
    const maxPages = options.maxPages ?? 5;
    const items: T[] = [];
    let next: string | undefined = this.resolve(path, options.query);
    let pages = 0;
    while (next && pages < maxPages) {
      const page: GetResult<T[]> = await this.get<T[]>(next, options.revalidate ? { revalidate: true } : {});
      if (!Array.isArray(page.data)) throw new UpstreamError("bad-response", `expected an array from ${path}`, 200);
      items.push(...page.data);
      next = page.link.next;
      pages++;
    }
    return { items, truncated: Boolean(next) };
  }

  /** Drops cached entries for one repository (webhook-driven invalidation). */
  invalidateRepo(fullName: string): number {
    const needle = `/repos/${fullName.toLowerCase()}`;
    let dropped = 0;
    for (const key of [...this.cache.keys()]) {
      const path = new URL(key).pathname.toLowerCase();
      if (path === needle || path.startsWith(needle + "/")) {
        this.cache.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  private async fetchWithRetry(url: string): Promise<GetResult<unknown>> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.fetchOnce(url);
      } catch (err) {
        const retryable = err instanceof UpstreamError && err.kind === "unavailable";
        if (retryable && attempt < this.maxRetries) {
          attempt++;
          this.stats.retries++;
          const backoff = 250 * 2 ** (attempt - 1);
          await this.sleep(backoff + Math.floor(Math.random() * 100));
          continue;
        }
        this.stats.errors++;
        const stale = this.cache.get(url);
        if (retryable && stale) {
          this.stats.stale++;
          return { data: stale.data, link: stale.link, source: "stale" };
        }
        throw err;
      }
    }
  }

  private async fetchOnce(url: string): Promise<GetResult<unknown>> {
    const cached = this.cache.get(url);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": this.apiVersion,
      "user-agent": this.userAgent,
    };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    else if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "network error";
      throw new UpstreamError("unavailable", `GitHub request ${reason}`, null);
    }
    this.readRate(res.headers);

    if (res.status === 304 && cached) {
      this.stats.revalidated++;
      cached.storedAt = this.now();
      this.touch(url, cached);
      return { data: cached.data, link: cached.link, source: "revalidated" };
    }
    if (res.status >= 200 && res.status < 300) {
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new UpstreamError("bad-response", "GitHub returned a body that is not JSON", res.status);
      }
      const entry: CacheEntry = {
        etag: res.headers.get("etag"),
        lastModified: res.headers.get("last-modified"),
        data,
        link: parseLinkHeader(res.headers.get("link")),
        storedAt: this.now(),
      };
      this.touch(url, entry);
      this.stats.network++;
      return { data, link: entry.link, source: "network" };
    }
    throw await this.classify(res);
  }

  private async classify(res: Response): Promise<UpstreamError> {
    const status = res.status;
    let message = "";
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message.slice(0, 200);
    } catch {
      /* non-JSON error body */
    }
    if (status === 404 || status === 410) return new UpstreamError("not-found", message || "not found", status);
    if (status === 401) return new UpstreamError("auth", "GitHub rejected the token", status);
    if (status === 403 || status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        return new UpstreamError("rate-limited", "GitHub secondary rate limit", status, Math.ceil(retryAfter));
      }
      if (res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const wait = Number.isFinite(reset) ? Math.max(1, Math.ceil(reset - this.now() / 1000)) : 60;
        return new UpstreamError("rate-limited", "GitHub primary rate limit exhausted", status, wait);
      }
      if (/secondary rate limit/i.test(message) || status === 429) {
        // GitHub: with no retry-after, wait at least one minute.
        return new UpstreamError("rate-limited", "GitHub secondary rate limit", status, 60);
      }
      return new UpstreamError("forbidden", message || "forbidden", status);
    }
    if (status >= 500) return new UpstreamError("unavailable", `GitHub returned ${status}`, status);
    return new UpstreamError("bad-response", message || `unexpected status ${status}`, status);
  }

  private readRate(h: Headers): void {
    const num = (name: string) => {
      const v = h.get(name);
      return v === null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
    };
    const remaining = num("x-ratelimit-remaining");
    if (remaining === null) return;
    const reset = num("x-ratelimit-reset");
    this.rate.limit = num("x-ratelimit-limit");
    this.rate.remaining = remaining;
    this.rate.used = num("x-ratelimit-used");
    this.rate.resource = h.get("x-ratelimit-resource");
    this.rate.resetAt = reset === null ? null : new Date(reset * 1000).toISOString();
  }

  private touch(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
