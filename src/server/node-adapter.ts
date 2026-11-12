// Bridges node:http to the Web-standard `handle(Request) => Response` used
// by the API core, plus a locked-down static file server for the dashboard.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";

export const WEBHOOK_MAX_BYTES = 1_100_000; // webhook ceiling (1 MB) plus headroom
export const API_MAX_BYTES = 64 * 1024; // every other body; the API itself caps JSON at 16 KiB

export async function toWebRequest(req: IncomingMessage, origin: string, maxBytes = API_MAX_BYTES): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? "GET";
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new RangeError("request body too large");
      chunks.push(chunk as Buffer);
    }
    body = new Uint8Array(Buffer.concat(chunks));
  }
  return new Request(new URL(req.url ?? "/", origin), { method, headers, ...(body ? { body } : {}) });
}

export async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((done, fail) => {
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res).on("finish", done).on("error", fail);
  });
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

export const PAGE_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
};

/**
 * Serves files from `root` only. Paths are resolved and must stay inside
 * root (no `..` escape); only known extensions are served, so a stray
 * source map, dotfile or config never leaks.
 */
export async function serveStatic(root: string, pathname: string, method: string): Promise<Response | null> {
  if (method !== "GET" && method !== "HEAD") return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.includes("\0")) return null;
  // No dotfiles or dot-directories, whatever the web root is set to.
  if (rel.split("/").some((seg) => seg.startsWith("."))) return null;
  if (rel.endsWith("/")) rel += "index.html";
  const base = resolve(root);
  const file = resolve(base, "." + rel);
  if (file !== base && !file.startsWith(base + sep)) return null;
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const data = await readFile(file);
    // Revalidate every asset: bundles are unhashed, so a long max-age would serve stale code after a rebuild.
    const cache = "no-cache";
    return new Response(method === "HEAD" ? null : new Uint8Array(data), {
      status: 200,
      headers: { "content-type": type, "cache-control": cache, ...PAGE_SECURITY_HEADERS },
    });
  } catch {
    return null;
  }
}

/**
 * DNS-rebinding guard. A page on an attacker's domain can rebind that name to
 * 127.0.0.1 and then call this server "same-origin"; the Host header still
 * carries the attacker's name, so only loopback names (plus explicit
 * ALLOWED_HOSTS) are accepted.
 */
export function hostAllowed(hostHeader: string | undefined, port: number, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...extra.map((h) => h.trim().toLowerCase()).filter(Boolean),
  ]);
  return allowed.has(host);
}

export function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
