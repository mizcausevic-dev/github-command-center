// A small method + path router built on Web standard Request/Response.
// It knows enough HTTP to answer correctly without the handler's help:
//   - 404 problem for unknown paths
//   - 405 problem with an `Allow` header for a known path and wrong method
//   - HEAD served by the GET handler with the body dropped
//   - OPTIONS answered with 204 and `Allow`

export type Params = Record<string, string>;

export interface Context {
  req: Request;
  url: URL;
  params: Params;
  requestId: string;
  clientId: string;
}

export type Handler = (ctx: Context) => Promise<Response> | Response;

export interface RouteInfo {
  method: string;
  pattern: string;
  operationId: string;
}

interface Route extends RouteInfo {
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export type MatchResult =
  | { kind: "found"; handler: Handler; params: Params; route: RouteInfo }
  | { kind: "method-not-allowed"; allow: string[] }
  | { kind: "not-found" };

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, operationId: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, pattern, operationId, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  list(): RouteInfo[] {
    return this.routes.map(({ method, pattern, operationId }) => ({ method, pattern, operationId }));
  }

  match(method: string, pathname: string): MatchResult {
    const allow = new Set<string>();
    const lookup = method === "HEAD" ? "GET" : method;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      allow.add(route.method);
      if (route.method !== lookup) continue;
      const params: Params = {};
      try {
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
      } catch {
        return { kind: "not-found" };
      }
      return { kind: "found", handler: route.handler, params, route };
    }
    if (allow.size === 0) return { kind: "not-found" };
    if (allow.has("GET")) allow.add("HEAD");
    allow.add("OPTIONS");
    return { kind: "method-not-allowed", allow: [...allow].sort() };
  }
}
