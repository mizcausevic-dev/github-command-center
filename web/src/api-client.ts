// Dashboard-side REST client. It keeps its own ETag cache and sends
// If-None-Match on every GET, so an unchanged list costs a 304 with an empty
// body. Every exchange is reported to the API inspector panel.

export type Transport = (req: Request) => Promise<Response>;

export interface Exchange {
  id: number;
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  reqHeaders: Array<[string, string]>;
  resHeaders: Array<[string, string]>;
  note: string;
  body: string;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: Array<{ pointer: string; detail: string }>;
}

export class ApiProblem extends Error {
  readonly problem: Problem;
  readonly response: Response;
  constructor(problem: Problem, response: Response) {
    super(problem.detail ?? problem.title);
    this.problem = problem;
    this.response = response;
  }
  get kind(): string {
    return this.problem.type.slice(this.problem.type.indexOf("#") + 1);
  }
}

const SHOWN_HEADERS = new Set([
  "if-none-match", "if-match", "idempotency-key", "cache-control", "content-type", "etag", "link", "location", "ratelimit",
  "ratelimit-policy", "retry-after", "idempotent-replayed", "allow", "x-request-id",
]);

export class ApiClient {
  private readonly transport: Transport;
  private readonly origin: string;
  private readonly cache = new Map<string, { etag: string; data: unknown }>();
  private readonly listeners: Array<(e: Exchange) => void> = [];
  private seq = 0;

  constructor(transport: Transport, origin: string) {
    this.transport = transport;
    this.origin = origin;
  }

  onExchange(fn: (e: Exchange) => void): void {
    this.listeners.push(fn);
  }

  async get<T>(path: string, opts: { revalidate?: boolean } = {}): Promise<{ data: T; headers: Headers }> {
    const headers: Record<string, string> = { accept: "application/json" };
    const cached = this.cache.get(path);
    if (cached) headers["if-none-match"] = cached.etag;
    // Always send an explicit request directive. Browsers append `Cache-Control: no-cache`
    // to fetches made with cache: "no-store" unless one is present, and the API treats
    // no-cache as "revalidate every upstream GitHub resource". max-age=60 accepts upstream
    // data up to a minute old; the Revalidate button sends no-cache on purpose.
    headers["cache-control"] = opts.revalidate ? "no-cache" : "max-age=60";
    const res = await this.exchange("GET", path, headers);
    if (res.status === 304 && cached) return { data: cached.data as T, headers: res.headers };
    const data = (await this.parse(res)) as T;
    const etag = res.headers.get("etag");
    if (etag) this.cache.set(path, { etag, data });
    return { data, headers: res.headers };
  }

  async send<T>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ data: T | null; headers: Headers; status: number }> {
    const headers: Record<string, string> = { accept: "application/json", "cache-control": "max-age=60", ...opts.headers };
    if (opts.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
    const res = await this.exchange(method, path, headers, opts.body === undefined ? undefined : JSON.stringify(opts.body));
    const data = res.status === 204 ? null : ((await this.parse(res)) as T);
    return { data, headers: res.headers, status: res.status };
  }

  /** ETag last seen for a GET path (used as If-Match for the next write). */
  etagOf(path: string): string | undefined {
    return this.cache.get(path)?.etag;
  }

  forget(prefix: string): void {
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  private async parse(res: Response): Promise<unknown> {
    const text = await res.clone().text();
    const body = text ? (JSON.parse(text) as unknown) : null;
    if (res.status >= 400) throw new ApiProblem(body as Problem, res);
    return body;
  }

  private async exchange(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Response> {
    const started = performance.now();
    const req = new Request(new URL(path, this.origin), { method, headers, ...(body !== undefined ? { body } : {}), cache: "no-store" });
    const res = await this.transport(req);
    const ms = Math.round(performance.now() - started);
    const text = res.status === 204 || res.status === 304 ? "" : await res.clone().text();
    const e: Exchange = {
      id: ++this.seq,
      at: Date.now(),
      method,
      path,
      status: res.status,
      ms,
      reqHeaders: Object.entries(headers).filter(([k]) => SHOWN_HEADERS.has(k)),
      resHeaders: [...res.headers.entries()].filter(([k]) => SHOWN_HEADERS.has(k)),
      note: res.status === 304 ? "client ETag hit" : res.headers.get("idempotent-replayed") ? "idempotent replay" : "",
      body: text.length > 6000 ? text.slice(0, 6000) + "\n…truncated" : text,
    };
    for (const fn of this.listeners) fn(e);
    return res;
  }
}
