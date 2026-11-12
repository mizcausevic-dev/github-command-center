// Keyset (cursor) pagination with RFC 8288 Link headers.
//
// Offset pagination skips or repeats rows when the list changes between page
// requests, and a dashboard list changes constantly (scores move, repos are
// connected). A keyset cursor records the sort key of the last item served, so
// the next page starts strictly after it regardless of inserts or deletes.
//
// The cursor is opaque base64url JSON: { k: <last key>, q: <query fingerprint> }.
// Binding it to the query fingerprint means a cursor minted for `?sort=name`
// is rejected (400) when replayed against `?sort=-attention` instead of
// returning a silently wrong page.

import { ApiError } from "./problem.ts";
import { base64urlDecode, base64urlEncode, fnv1a, fromUtf8, utf8 } from "./encoding.ts";

export type KeyPart = string | number;
export type Key = KeyPart[];
export type KeyComparator = (a: Key, b: Key) => number;

export interface PageParams {
  limit: number;
  after: Key | undefined;
  fingerprint: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | undefined;
}

const MAX_LIMIT = 100;

/** Fingerprint of every query param except paging controls, order-insensitive. */
export function queryFingerprint(url: URL): string {
  const pairs = [...url.searchParams.entries()]
    .filter(([k]) => k !== "cursor" && k !== "limit")
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  return fnv1a(url.pathname + "?" + new URLSearchParams(pairs).toString());
}

export function readPageParams(url: URL, defaultLimit = 20, maxLimit = MAX_LIMIT): PageParams {
  const rawLimit = url.searchParams.get("limit");
  let limit = defaultLimit;
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > maxLimit) {
      throw new ApiError(400, "bad-request", "Invalid limit", `limit must be an integer from 1 to ${maxLimit}`, {
        errors: [{ pointer: "query:limit", detail: `expected 1..${maxLimit}` }],
      });
    }
    limit = Number(rawLimit);
  }
  const fingerprint = queryFingerprint(url);
  const cursor = url.searchParams.get("cursor");
  return { limit, after: cursor ? decodeCursor(cursor, fingerprint) : undefined, fingerprint };
}

export function encodeCursor(key: Key, fingerprint: string): string {
  return base64urlEncode(utf8(JSON.stringify({ k: key, q: fingerprint })));
}

export function decodeCursor(cursor: string, fingerprint: string): Key {
  const bad = (detail: string) =>
    new ApiError(400, "bad-cursor", "Invalid cursor", detail, {
      errors: [{ pointer: "query:cursor", detail }],
    });
  if (cursor.length > 512) throw bad("cursor is too long");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(base64urlDecode(cursor)));
  } catch {
    throw bad("cursor is not a value this API issued");
  }
  if (typeof parsed !== "object" || parsed === null) throw bad("cursor is not a value this API issued");
  const { k, q } = parsed as { k?: unknown; q?: unknown };
  const validKey =
    Array.isArray(k) && k.length > 0 && k.length <= 4 && k.every((p) => typeof p === "string" || typeof p === "number");
  if (!validKey || typeof q !== "string") throw bad("cursor is not a value this API issued");
  if (q !== fingerprint) throw bad("cursor was issued for a different query; restart from the first page");
  return k as Key;
}

/** Generic comparator over composite keys; `directions[i]` is 1 (asc) or -1 (desc). */
export function keyComparator(directions: Array<1 | -1>): KeyComparator {
  return (a, b) => {
    for (let i = 0; i < directions.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      if (c !== 0) return c * (directions[i] ?? 1);
    }
    return 0;
  };
}

/**
 * Sorts by `keyOf`, then returns the slice strictly after `params.after`.
 * Keys must be unique (end every key with a unique tiebreaker such as an id).
 */
export function paginate<T>(items: T[], keyOf: (t: T) => Key, compare: KeyComparator, params: PageParams): Page<T> {
  const sorted = [...items].sort((a, b) => compare(keyOf(a), keyOf(b)));
  const after = params.after;
  const start = after === undefined ? 0 : sorted.findIndex((t) => compare(keyOf(t), after) > 0);
  const begin = start === -1 ? sorted.length : start;
  const slice = sorted.slice(begin, begin + params.limit);
  const last = slice[slice.length - 1];
  const hasMore = begin + params.limit < sorted.length;
  return {
    items: slice,
    nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last), params.fingerprint) : undefined,
  };
}

/** RFC 8288 Link header with `first` and (when there is one) `next`. */
export function linkHeader(url: URL, limit: number, nextCursor: string | undefined): string {
  const build = (cursor: string | undefined) => {
    const u = new URL(url.toString());
    u.searchParams.delete("cursor");
    u.searchParams.set("limit", String(limit));
    if (cursor) u.searchParams.set("cursor", cursor);
    return u.pathname + u.search;
  };
  const links = [`<${build(undefined)}>; rel="first"`];
  if (nextCursor) links.push(`<${build(nextCursor)}>; rel="next"`);
  return links.join(", ");
}
