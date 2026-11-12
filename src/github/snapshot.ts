// Replays a recorded set of GitHub REST responses through a fetch-compatible
// function. It mirrors the upstream behaviors the client depends on, so the
// demo and the tests exercise the real code paths:
//   - recorded ETag + If-None-Match -> 304 with no body
//   - Link headers for pagination, exactly as recorded
//   - x-ratelimit-* headers; a 304 does not spend budget, a 200 does
//   - unknown URL -> 404 JSON like GitHub's

import type { FetchLike } from "./client.ts";

export interface SnapshotEntry {
  status: number;
  etag?: string;
  link?: string;
  body: unknown;
}

export interface SnapshotWorkspaceSeed {
  fullName: string;
  priority: "P0" | "P1" | "P2" | "P3";
  pinned?: boolean;
  notes?: string;
}

export interface SnapshotActionSeed {
  repo: string;
  title: string;
  /** Days relative to recordedAt; negative means overdue at recording time. */
  dueInDays: number | null;
  status?: "open" | "done";
}

export interface Snapshot {
  version: 1;
  recordedAt: string;
  owner: string;
  apiVersion: string;
  catalog: string[];
  workspace: SnapshotWorkspaceSeed[];
  nextActions: SnapshotActionSeed[];
  responses: Record<string, SnapshotEntry>;
}

/** Canonical key: path plus query string exactly as requested (no origin). */
export function snapshotKey(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

export interface SnapshotFetchOptions {
  rateLimit?: number;
  now?: () => number;
  /** Optional artificial latency so the demo's loading states are visible. */
  latencyMs?: number;
}

export function snapshotFetch(snapshot: Snapshot, options: SnapshotFetchOptions = {}): FetchLike & { remaining: () => number } {
  const limit = options.rateLimit ?? 5000;
  const now = options.now ?? Date.now;
  let remaining = limit;
  const resetAt = Math.floor(now() / 1000) + 3600;

  const fn = async (input: string, init?: RequestInit): Promise<Response> => {
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    const headers = new Headers(init?.headers);
    const entry = snapshot.responses[snapshotKey(input)];
    const rate = () => ({
      "x-ratelimit-limit": String(limit),
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-used": String(limit - remaining),
      "x-ratelimit-reset": String(resetAt),
      "x-ratelimit-resource": "core",
    });
    if (!entry) {
      remaining = Math.max(0, remaining - 1);
      return new Response(JSON.stringify({ message: "Not Found", status: "404" }), {
        status: 404,
        headers: { "content-type": "application/json", ...rate() },
      });
    }
    const inm = headers.get("if-none-match");
    if (entry.etag && inm && inm === entry.etag) {
      return new Response(null, { status: 304, headers: { etag: entry.etag, ...rate() } });
    }
    remaining = Math.max(0, remaining - 1);
    const out: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...rate() };
    if (entry.etag) out["etag"] = entry.etag;
    if (entry.link) out["link"] = entry.link;
    return new Response(JSON.stringify(entry.body), { status: entry.status, headers: out });
  };
  return Object.assign(fn, { remaining: () => remaining });
}
