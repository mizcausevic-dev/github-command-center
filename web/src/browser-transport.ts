// GitHub Pages demo: the real API (same router, validation, ETags, problem
// details) runs in the page. GitHub responses come from the recorded
// snapshot; the workspace (priorities, next actions) persists per visitor in
// localStorage, which is a convenience only and may be unavailable.

import { createApp } from "../../src/api/app.ts";
import { GitHubClient } from "../../src/github/client.ts";
import { snapshotFetch, type Snapshot } from "../../src/github/snapshot.ts";
import { Store, parseStoreState, type StoreState } from "../../src/domain/store.ts";
import { seedState } from "../../src/demo-seed.ts";
import type { Transport } from "./api-client.ts";

const KEY = "gcc.demo.workspace.v1";

export async function createBrowserTransport(): Promise<{ transport: Transport; reset: () => void }> {
  const res = await fetch("snapshot.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`snapshot.json: HTTP ${res.status}`);
  const snapshot = (await res.json()) as Snapshot;
  const frozen = Date.parse(snapshot.recordedAt);
  const now = () => frozen;

  let initial: StoreState = seedState(snapshot);
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? parseStoreState(JSON.parse(raw)) : undefined;
    if (saved) initial = saved;
  } catch {
    /* storage blocked or corrupt: start from the seed */
  }
  const store = new Store(initial, (state) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore quota or privacy-mode failures */
    }
  });
  const github = new GitHubClient({ fetch: snapshotFetch(snapshot, { now, latencyMs: 20 }), userAgent: "demo", now });
  const app = createApp({
    github,
    store,
    now,
    mode: "snapshot",
    snapshot: { recordedAt: snapshot.recordedAt, catalog: snapshot.catalog },
    rateLimit: false,
  });
  return {
    transport: (req) => app.handle(req, { clientId: "browser" }),
    reset: () => {
      try {
        localStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
  };
}
