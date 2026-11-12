// Node entry point.
//
//   GITHUB_TOKEN=$(gh auth token) npm start     live GitHub data
//   npm run demo                                 recorded snapshot, no token needed
//
// Environment:
//   GITHUB_TOKEN    read-only token (fine-grained, "Metadata" + "Contents" + "Issues" +
//                   "Pull requests" + "Actions" read) - required in live mode
//   HOST / PORT     bind address, default 127.0.0.1:8787 (loopback only)
//   API_TOKEN       when set, every /api request needs "Authorization: Bearer <API_TOKEN>"
//   WEBHOOK_SECRET  enables POST /api/v1/webhooks/github (HMAC-SHA256)
//   DATA_FILE       workspace state file, default .data/workspace.json
//   REPOS           comma list of owner/name to connect on first start

import { createServer } from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../api/app.ts";
import { GitHubClient } from "../github/client.ts";
import { snapshotFetch, type Snapshot } from "../github/snapshot.ts";
import { Store, parseStoreState, type StoreState } from "../domain/store.ts";
import { seedState } from "../demo-seed.ts";
import { PAGE_SECURITY_HEADERS, sendWebResponse, serveStatic, toWebRequest } from "./node-adapter.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const demo = process.argv.includes("--demo");
const env = process.env;
const flag = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const host = env["HOST"] ?? "127.0.0.1";
const port = Number(flag("port") ?? env["PORT"] ?? 8787);
const token = env["GITHUB_TOKEN"];

if (!demo && !token) {
  console.error("GITHUB_TOKEN is required in live mode. Use `npm run demo` to run against the recorded snapshot.");
  process.exit(1);
}

let snapshot: Snapshot | undefined;
let now = () => Date.now();
let initial: StoreState;
let persist: (s: StoreState) => void = () => {};

if (demo) {
  snapshot = JSON.parse(readFileSync(resolve(ROOT, "demo/snapshot.json"), "utf8")) as Snapshot;
  const frozen = Date.parse(snapshot.recordedAt);
  // Freeze the clock at recording time so ages and "overdue" stay consistent with the data.
  now = () => frozen;
  initial = seedState(snapshot);
} else {
  const file = resolve(ROOT, env["DATA_FILE"] ?? ".data/workspace.json");
  let loaded: StoreState | undefined;
  if (existsSync(file)) {
    loaded = parseStoreState(JSON.parse(readFileSync(file, "utf8")));
    if (!loaded) {
      console.error(`${file} is not a valid workspace file; refusing to overwrite it.`);
      process.exit(1);
    }
  }
  const at = new Date().toISOString();
  initial = loaded ?? {
    version: 1,
    repos: (env["REPOS"] ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((fullName) => ({ fullName, priority: "P2", notes: "", pinned: false, connectedAt: at, updatedAt: at })),
    nextActions: [],
  };
  mkdirSync(dirname(file), { recursive: true });
  // Atomic write: a crash mid-write leaves the previous file intact.
  persist = (state) => {
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${file}.tmp`, file);
  };
}

const github = new GitHubClient({
  fetch: demo && snapshot ? snapshotFetch(snapshot, { now }) : (input, init) => fetch(input, init),
  token: demo ? undefined : token,
  userAgent: "github-command-center/1.0 (+https://github.com/mizcausevic-dev/github-command-center)",
  now,
});

const app = createApp({
  github,
  store: new Store(initial, persist),
  now,
  mode: demo ? "snapshot" : "live",
  ...(snapshot ? { snapshot: { recordedAt: snapshot.recordedAt, catalog: snapshot.catalog } } : {}),
  webhookSecret: env["WEBHOOK_SECRET"],
  apiToken: env["API_TOKEN"],
  log: (e) => {
    if (e.error || e.status >= 500) console.error(JSON.stringify(e));
    else if (env["LOG_REQUESTS"]) console.log(JSON.stringify(e));
  },
});

const webRoot = resolve(ROOT, flag("web-root") ?? env["WEB_ROOT"] ?? "dist/web");
const origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;

const server = createServer(async (req, res) => {
  try {
    const request = await toWebRequest(req, origin);
    const path = new URL(request.url).pathname;
    if (path === "/healthz") {
      await sendWebResponse(res, new Response('{"status":"ok"}', { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
      return;
    }
    if (path.startsWith("/api/")) {
      await sendWebResponse(res, await app.handle(request, { clientId: req.socket.remoteAddress ?? "unknown" }));
      return;
    }
    const file = await serveStatic(webRoot, path, request.method);
    await sendWebResponse(
      res,
      file ?? new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...PAGE_SECURITY_HEADERS } }),
    );
  } catch (err) {
    const tooLarge = err instanceof RangeError;
    if (!res.headersSent) {
      res.writeHead(tooLarge ? 413 : 500, { "content-type": "application/problem+json" });
      res.end(JSON.stringify({ title: tooLarge ? "Payload too large" : "Internal error", status: tooLarge ? 413 : 500 }));
    }
    if (!tooLarge) console.error(err);
  }
});

server.listen(port, host, () => {
  console.log(`github-command-center (${demo ? "demo snapshot" : "live"}) listening on ${origin}`);
  if (!existsSync(webRoot)) console.log("dashboard not built yet: run `npm run build`");
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
