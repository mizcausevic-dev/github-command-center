// Idempotency-Key support for POST (draft-ietf-httpapi-idempotency-key-header).
//
// A client that times out on POST cannot know whether the server created the
// resource. Re-sending with the same Idempotency-Key replays the first
// response instead of creating a duplicate. Rules:
//   - same key + same request fingerprint, finished  -> replay stored response
//   - same key + same fingerprint, still running     -> 409 (in flight)
//   - same key + different method/path/body           -> 422 (key reuse)
//   - 5xx and 429 responses are not stored, so a retry can still succeed.

import { ApiError } from "./problem.ts";

interface StoredResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

interface Entry {
  fingerprint: string;
  state: "pending" | "done";
  response?: StoredResponse;
  expiresAt: number;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 1000;
    this.now = options.now ?? Date.now;
  }

  static validateKey(key: string): void {
    if (key.length < 8 || key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) {
      throw new ApiError(400, "bad-request", "Invalid Idempotency-Key", "Idempotency-Key must be 8-255 visible ASCII characters", {
        errors: [{ pointer: "header:idempotency-key", detail: "expected 8-255 visible ASCII characters" }],
      });
    }
  }

  async run(scope: string, key: string, fingerprint: string, handler: () => Promise<Response>): Promise<Response> {
    IdempotencyStore.validateKey(key);
    this.sweep();
    const id = `${scope}\u0000${key}`;
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ApiError(422, "idempotency-mismatch", "Idempotency-Key reused", "This Idempotency-Key was already used with a different request");
      }
      if (existing.state === "pending" || !existing.response) {
        throw new ApiError(409, "idempotency-in-flight", "Request still in progress", "A request with this Idempotency-Key is still being processed; retry shortly", {
          headers: { "retry-after": "1" },
        });
      }
      const stored = existing.response;
      const headers = new Headers(stored.headers);
      headers.set("idempotent-replayed", "true");
      return new Response(stored.body, { status: stored.status, headers });
    }

    this.entries.set(id, { fingerprint, state: "pending", expiresAt: this.now() + this.ttlMs });
    let response: Response;
    try {
      response = await handler();
    } catch (err) {
      // A thrown error produced no resource; release the key so a corrected
      // retry (or the same retry after an upstream outage) can proceed.
      this.entries.delete(id);
      throw err;
    }
    if (response.status >= 500 || response.status === 429) {
      this.entries.delete(id);
      return response;
    }
    const body = await response.clone().text();
    this.entries.set(id, {
      fingerprint,
      state: "done",
      response: { status: response.status, headers: [...response.headers.entries()], body },
      expiresAt: this.now() + this.ttlMs,
    });
    return response;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.expiresAt <= t) this.entries.delete(k);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
