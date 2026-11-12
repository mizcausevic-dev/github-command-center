// Token-bucket rate limiting for this API's own clients, advertised with the
// IETF RateLimit / RateLimit-Policy header fields
// (draft-ietf-httpapi-ratelimit-headers) so clients can pace themselves
// before they hit 429.

export interface RateDecision {
  ok: boolean;
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSec: number;
  /** Seconds until one token is available (only meaningful when !ok). */
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly capacity: number;
  readonly windowSec: number;
  private readonly refillPerMs: number;
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxClients: number;

  constructor(options: { capacity: number; windowSec: number; now?: () => number; maxClients?: number }) {
    this.capacity = options.capacity;
    this.windowSec = options.windowSec;
    this.refillPerMs = options.capacity / (options.windowSec * 1000);
    this.now = options.now ?? Date.now;
    this.maxClients = options.maxClients ?? 10_000;
  }

  take(clientId: string, cost = 1): RateDecision {
    const t = this.now();
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      if (this.buckets.size >= this.maxClients) this.evictFullBuckets(t);
      bucket = { tokens: this.capacity, updatedAt: t };
      this.buckets.set(clientId, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = t;
    const ok = bucket.tokens >= cost;
    if (ok) bucket.tokens -= cost;
    const missing = this.capacity - bucket.tokens;
    return {
      ok,
      remaining: Math.floor(bucket.tokens),
      resetSec: Math.ceil(missing / this.refillPerMs / 1000),
      retryAfterSec: ok ? 0 : Math.max(1, Math.ceil((cost - bucket.tokens) / this.refillPerMs / 1000)),
    };
  }

  headers(decision: RateDecision): Record<string, string> {
    return {
      "ratelimit-policy": `"default";q=${this.capacity};w=${this.windowSec}`,
      ratelimit: `"default";r=${decision.remaining};t=${decision.resetSec}`,
    };
  }

  private evictFullBuckets(t: number): void {
    for (const [id, b] of this.buckets) {
      if (b.tokens + (t - b.updatedAt) * this.refillPerMs >= this.capacity) this.buckets.delete(id);
    }
    // Still full of active clients: drop the oldest insertion to bound memory.
    if (this.buckets.size >= this.maxClients) {
      const first = this.buckets.keys().next().value;
      if (first !== undefined) this.buckets.delete(first);
    }
  }
}
