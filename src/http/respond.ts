import { etagFor, ifNoneMatchHits } from "./conditional.ts";

export interface JsonOptions {
  status?: number;
  headers?: Record<string, string>;
  /** Compute a strong ETag and honor If-None-Match (GET/HEAD 200 only). */
  etag?: boolean;
}

/**
 * Serializes `data` once, tags it, and answers conditional GETs with 304.
 * Cache-Control `private, no-cache` lets a browser or client keep the body
 * but forces revalidation each time, which is cheap because a match costs a
 * hash and an empty 304.
 */
export async function json(req: Request, data: unknown, options: JsonOptions = {}): Promise<Response> {
  const status = options.status ?? 200;
  const body = JSON.stringify(data);
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", ...options.headers });
  const conditional = options.etag !== false && status === 200 && (req.method === "GET" || req.method === "HEAD");
  if (conditional || options.etag === true) {
    const tag = await etagFor(body);
    headers.set("etag", tag);
    if (!headers.has("cache-control")) headers.set("cache-control", "private, no-cache");
    if (conditional && ifNoneMatchHits(req.headers.get("if-none-match"), tag)) {
      headers.delete("content-type");
      return new Response(null, { status: 304, headers });
    }
  }
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return new Response(body, { status, headers });
}

export function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...headers } });
}
