// Composition root: one `handle(Request) => Response` function that the Node
// server and the in-browser demo both call. Cross-cutting HTTP concerns run
// here in a fixed order so no route can forget them:
//
//   request id -> auth -> rate limit -> content negotiation -> route (404/405/OPTIONS/HEAD)
//   -> handler -> problem+json on any error -> common response headers

import { InsightService } from "../domain/insights.ts";
import { IdempotencyStore } from "../http/idempotency.ts";
import { ApiError, problemResponse } from "../http/problem.ts";
import { RateLimiter } from "../http/ratelimit.ts";
import { Router } from "../http/router.ts";
import { timingSafeEqualText } from "../http/encoding.ts";
import type { AppDeps, Services } from "./deps.ts";
import { registerRepoRoutes } from "./routes-repos.ts";
import { registerActionRoutes } from "./routes-actions.ts";
import { registerMetaRoutes } from "./routes-meta.ts";

export interface App {
  handle(req: Request, info?: { clientId?: string }): Promise<Response>;
  router: Router;
  services: Services;
}

const ACCEPTABLE = /(^|,)\s*(\*\/\*|application\/\*|application\/json|application\/problem\+json)\s*(;|,|$)/i;

function defaultId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

export function createApp(deps: AppDeps): App {
  const services: Services = {
    ...deps,
    insights: new InsightService(deps.github, deps.now),
    idempotency: new IdempotencyStore({ now: deps.now }),
    newId: deps.newId ?? defaultId,
    deliveries: new Set(),
  };
  const router = new Router();
  registerMetaRoutes(router, services);
  registerRepoRoutes(router, services);
  registerActionRoutes(router, services);

  const limiter = deps.rateLimit === false ? null : new RateLimiter({ ...(deps.rateLimit ?? { capacity: 120, windowSec: 60 }), now: deps.now });

  async function handle(req: Request, info: { clientId?: string } = {}): Promise<Response> {
    const started = Date.now();
    const url = new URL(req.url);
    const incomingId = req.headers.get("x-request-id");
    const requestId = incomingId && /^[A-Za-z0-9._-]{1,64}$/.test(incomingId) ? incomingId : defaultId();
    const clientId = info.clientId ?? "local";
    const extra: Record<string, string> = { "x-request-id": requestId };
    let res: Response;
    try {
      res = await dispatch(req, url, requestId, clientId, extra);
    } catch (err) {
      const apiErr =
        err instanceof ApiError
          ? err
          : new ApiError(500, "internal", "Internal error", "The server hit an unexpected error; quote the requestId when reporting it");
      if (!(err instanceof ApiError)) {
        deps.log?.({ at: new Date().toISOString(), requestId, method: req.method, path: url.pathname, status: 500, ms: 0, error: String(err) });
      }
      res = problemResponse(apiErr, url.pathname, requestId);
      if (apiErr.status === 405 && apiErr.headers["allow"]) res.headers.set("allow", apiErr.headers["allow"]);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    headers.set("x-content-type-options", "nosniff");
    if (!headers.has("vary")) headers.set("vary", "Accept, Authorization");
    const body = req.method === "HEAD" ? null : res.body;
    const out = new Response(res.status === 204 || res.status === 304 ? null : body, { status: res.status, headers });
    deps.log?.({ at: new Date().toISOString(), requestId, method: req.method, path: url.pathname, status: out.status, ms: Date.now() - started });
    return out;
  }

  async function dispatch(req: Request, url: URL, requestId: string, clientId: string, extra: Record<string, string>): Promise<Response> {
    const isWebhook = url.pathname === "/api/v1/webhooks/github";
    if (deps.apiToken && !isWebhook) {
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!token || !timingSafeEqualText(token, deps.apiToken)) {
        throw new ApiError(401, "unauthorized", "Authentication required", "Send Authorization: Bearer <API_TOKEN>", {
          headers: { "www-authenticate": 'Bearer realm="command-center"' },
        });
      }
    }
    if (limiter) {
      const decision = limiter.take(clientId, req.method === "GET" || req.method === "HEAD" ? 1 : 2);
      Object.assign(extra, limiter.headers(decision));
      if (!decision.ok) {
        throw new ApiError(429, "rate-limited", "Too many requests", `Rate limit exceeded; retry in ${decision.retryAfterSec}s`, {
          headers: { "retry-after": String(decision.retryAfterSec) },
        });
      }
    }
    const accept = req.headers.get("accept");
    if (accept && !ACCEPTABLE.test(accept)) {
      throw new ApiError(406, "not-acceptable", "Not acceptable", "This API produces application/json and application/problem+json");
    }
    const match = router.match(req.method, url.pathname);
    if (match.kind === "not-found") throw new ApiError(404, "not-found", "Resource not found", `No resource at ${url.pathname}`);
    if (match.kind === "method-not-allowed") {
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { allow: match.allow.join(", "), "cache-control": "no-store" } });
      }
      throw new ApiError(405, "method-not-allowed", "Method not allowed", `${req.method} is not supported on ${url.pathname}`, {
        headers: { allow: match.allow.join(", ") },
      });
    }
    return match.handler({ req, url, params: match.params, requestId, clientId });
  }

  return { handle, router, services };
}
