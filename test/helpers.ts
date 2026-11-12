import { readFileSync } from "node:fs";
import { createApp, type App } from "../src/api/app.ts";
import { GitHubClient } from "../src/github/client.ts";
import { snapshotFetch, type Snapshot } from "../src/github/snapshot.ts";
import { Store } from "../src/domain/store.ts";
import { seedState } from "../src/demo-seed.ts";

export const snapshot = JSON.parse(readFileSync(new URL("../demo/snapshot.json", import.meta.url), "utf8")) as Snapshot;
export const NOW = Date.parse(snapshot.recordedAt);

export interface TestApp {
  app: App;
  github: GitHubClient;
  upstream: ReturnType<typeof snapshotFetch>;
  call: (method: string, path: string, init?: { headers?: Record<string, string>; body?: unknown; raw?: string }) => Promise<Response>;
}

export function makeApp(options: { apiToken?: string; webhookSecret?: string; rateLimit?: { capacity: number; windowSec: number } | false } = {}): TestApp {
  const now = () => NOW;
  const upstream = snapshotFetch(snapshot, { now });
  const github = new GitHubClient({ fetch: upstream, userAgent: "test", now, sleep: async () => {} });
  let n = 0;
  const app = createApp({
    github,
    store: new Store(seedState(snapshot)),
    now,
    mode: "snapshot",
    snapshot: { recordedAt: snapshot.recordedAt, catalog: snapshot.catalog },
    webhookSecret: options.webhookSecret,
    apiToken: options.apiToken,
    rateLimit: options.rateLimit ?? false,
    newId: () => `na_test_${String(++n).padStart(4, "0")}`,
  });
  const call: TestApp["call"] = (method, path, init = {}) => {
    const headers = new Headers(init.headers);
    let body: string | undefined = init.raw;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    return app.handle(new Request(`http://local${path}`, { method, headers, ...(body !== undefined ? { body } : {}) }));
  };
  return { app, github, upstream, call };
}

export async function problemOf(res: Response): Promise<{ type: string; status: number; errors?: Array<{ pointer: string; detail: string }> }> {
  if (res.headers.get("content-type") !== "application/problem+json") throw new Error(`expected problem+json, got ${res.headers.get("content-type")}`);
  return res.json() as Promise<{ type: string; status: number }>;
}

export const typeOf = (t: string) => t.slice(t.indexOf("#") + 1);
