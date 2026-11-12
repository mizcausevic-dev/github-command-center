import type { GitHubClient } from "../github/client.ts";
import { UpstreamError } from "../github/client.ts";
import { ApiError } from "../http/problem.ts";
import type { InsightService } from "../domain/insights.ts";
import type { Store } from "../domain/store.ts";
import type { IdempotencyStore } from "../http/idempotency.ts";

export interface SnapshotInfo {
  recordedAt: string;
  catalog: string[];
}

export interface LogEntry {
  at: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  error?: string;
}

export interface AppDeps {
  github: GitHubClient;
  store: Store;
  now: () => number;
  mode: "live" | "snapshot";
  snapshot?: SnapshotInfo;
  webhookSecret?: string | undefined;
  apiToken?: string | undefined;
  rateLimit?: { capacity: number; windowSec: number } | false;
  newId?: () => string;
  log?: (entry: LogEntry) => void;
}

export interface Services extends AppDeps {
  insights: InsightService;
  idempotency: IdempotencyStore;
  newId: () => string;
  /** Recently processed webhook deliveries (replay protection). */
  deliveries: Set<string>;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Path parameters are interpolated into GitHub API paths, so they must be a
 * plain owner/name pair. Without this check `..` or an encoded slash in a
 * parameter could steer requests to a different GitHub endpoint.
 */
export function repoParam(owner: string | undefined, repo: string | undefined): string {
  if (!owner || !repo || !OWNER.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") {
    throw new ApiError(404, "not-found", "Resource not found", "No repository matches that owner/name");
  }
  return `${owner}/${repo}`;
}

export function isValidFullName(fullName: string): boolean {
  const [owner, repo, extra] = fullName.split("/");
  return extra === undefined && !!owner && !!repo && OWNER.test(owner) && NAME.test(repo) && repo !== "." && repo !== "..";
}

export function repoPath(fullName: string): string {
  const [owner, repo] = fullName.split("/");
  return `/api/v1/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
}

/** Translates upstream failures into problem responses a client can act on. */
export function upstreamToApi(err: unknown, notFoundDetail = "Repository not found on GitHub"): never {
  if (!(err instanceof UpstreamError)) throw err;
  switch (err.kind) {
    case "not-found":
      throw new ApiError(404, "not-found", "Resource not found", notFoundDetail);
    case "rate-limited": {
      const retry = String(err.retryAfterSec ?? 60);
      throw new ApiError(503, "upstream-rate-limited", "GitHub rate limit reached", `${err.message}; retry after ${retry}s`, {
        headers: { "retry-after": retry },
      });
    }
    case "auth":
    case "forbidden":
      throw new ApiError(502, "upstream-unavailable", "GitHub refused the request", err.message);
    case "unavailable":
      throw new ApiError(503, "upstream-unavailable", "GitHub is unavailable", err.message, { headers: { "retry-after": "30" } });
    default:
      throw new ApiError(502, "upstream-unavailable", "Unexpected response from GitHub", err.message);
  }
}

/**
 * Request directives (RFC 9111 §5.2.1): `no-cache` or `max-age=0` means the client
 * will not accept stored upstream data, so every GitHub resource is revalidated with
 * a conditional request. Any other value (or none) allows the client's fresh window.
 */
export function wantsRevalidate(req: Request): boolean {
  const cc = (req.headers.get("cache-control") ?? "").toLowerCase();
  return /\bno-cache\b|\bmax-age=0\b/.test(cc);
}

export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export type { GitHubClient };
