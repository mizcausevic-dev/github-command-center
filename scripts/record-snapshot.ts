// Records the demo snapshot from the live GitHub REST API.
//
//   GITHUB_TOKEN=<fine-grained read-only token> npm run record
//
// Safety properties (each enforced below, not just documented):
//   1. Public repositories only: a private repo aborts the run.
//   2. Allow-list sanitizing: only fields in src/github/sanitize.ts are kept.
//   3. Only the owner's and bots' issues/PRs are kept, so the public snapshot
//      republishes no third-party authored content.
//   4. An e-mail pattern anywhere in the output aborts the run.
//   5. The written snapshot is replayed offline; any request the replay
//      cannot answer aborts the run.
// The token is read from the environment and never printed or written.

import { readFileSync, writeFileSync } from "node:fs";
import { GitHubClient, type FetchLike } from "../src/github/client.ts";
import { snapshotFetch, snapshotKey, type Snapshot, type SnapshotEntry } from "../src/github/snapshot.ts";
import { findEmails, sanitizeResponse } from "../src/github/sanitize.ts";
import { InsightService, isBotLogin } from "../src/domain/insights.ts";
import { scoreRepo } from "../src/domain/attention.ts";

interface Config {
  owner: string;
  catalog: string[];
  workspace: Snapshot["workspace"];
  nextActions: Snapshot["nextActions"];
}

const token = process.env["GITHUB_TOKEN"];
if (!token) {
  console.error("Set GITHUB_TOKEN to a fine-grained, read-only token (see README)");
  process.exit(1);
}

const config = JSON.parse(readFileSync(new URL("./snapshot.config.json", import.meta.url), "utf8")) as Config;
const recordedAtMs = Date.now();
const responses: Record<string, SnapshotEntry> = {};

const recordingFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  if (res.status < 200 || res.status >= 300) return res;
  const path = new URL(url).pathname;
  const body = sanitizeResponse(path, await res.json());
  const entry: SnapshotEntry = { status: res.status, body };
  const etag = res.headers.get("etag");
  const link = res.headers.get("link");
  if (etag) entry.etag = etag;
  if (link) entry.link = link;
  responses[snapshotKey(url)] = entry;
  const headers = new Headers(res.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: res.status, headers });
};

const client = new GitHubClient({ fetch: recordingFetch, token, userAgent: "github-command-center-recorder", now: () => recordedAtMs, maxRetries: 2 });
const insights = new InsightService(client, () => recordedAtMs);

for (const fullName of config.catalog) {
  const repo = await insights.loadRepo(fullName);
  if (repo.private || repo.visibility !== "public") {
    console.error(`ABORT: ${fullName} is not public`);
    process.exit(2);
  }
  await insights.load(fullName);
  process.stdout.write(".");
}
process.stdout.write("\n");

// Rule 3: drop issues/PRs and events by anyone other than the owner or a bot, and blank
// third-party commit messages (the commit still counts toward activity).
let dropped = 0;
const firstParty = (u: { login: string; type?: string } | null | undefined) =>
  !!u && (u.login.toLowerCase() === config.owner.toLowerCase() || isBotLogin(u));
for (const [key, entry] of Object.entries(responses)) {
  if (!Array.isArray(entry.body)) continue;
  if (/\/events(\?|$)/.test(key)) {
    const kept = (entry.body as Array<{ actor: { login: string } }>).filter((e) => firstParty(e.actor));
    dropped += entry.body.length - kept.length;
    entry.body = kept;
  } else if (/\/commits(\?|$)/.test(key)) {
    for (const c of entry.body as Array<{ author: { login: string } | null; commit: { message: string } }>) {
      if (!firstParty(c.author)) {
        c.commit.message = "";
        c.author = null;
      }
    }
  }
}
for (const [key, entry] of Object.entries(responses)) {
  if (!/\/(issues|pulls)(\?|$)/.test(key) || !Array.isArray(entry.body)) continue;
  const before = entry.body.length;
  const kept = (entry.body as Array<{ user: { login: string; type?: string } | null }>).filter(
    (i) => i.user && (i.user.login.toLowerCase() === config.owner.toLowerCase() || isBotLogin(i.user)),
  );
  entry.body = kept;
  dropped += before - kept.length;
}

const snapshot: Snapshot = {
  version: 1,
  recordedAt: new Date(recordedAtMs).toISOString(),
  owner: config.owner,
  apiVersion: client.apiVersion,
  catalog: config.catalog,
  workspace: config.workspace,
  nextActions: config.nextActions,
  responses,
};
const text = JSON.stringify(snapshot);

const emails = findEmails(text);
if (emails.length > 0) {
  console.error(`ABORT: ${emails.length} e-mail-like string(s) found in the snapshot; inspect the sanitizer`);
  process.exit(3);
}

// Rule 5: replay offline and require every request to be answerable.
const replayFetch = snapshotFetch(snapshot, { now: () => recordedAtMs });
let misses = 0;
const counting: FetchLike = async (url, init) => {
  const r = await replayFetch(url, init);
  if (r.status === 404) {
    misses++;
    console.error(`replay miss: ${snapshotKey(url)}`);
  }
  return r;
};
const replay = new InsightService(new GitHubClient({ fetch: counting, userAgent: "replay", now: () => recordedAtMs }), () => recordedAtMs);
const rows: string[] = [];
for (const fullName of config.catalog) {
  const i = await replay.load(fullName);
  const seed = config.workspace.find((w) => w.fullName.toLowerCase() === fullName.toLowerCase());
  const a = scoreRepo(i, { fullName, priority: seed?.priority ?? "P2", notes: "", pinned: false, connectedAt: "", updatedAt: "" }, [], recordedAtMs);
  rows.push(
    [
      fullName.padEnd(52),
      `iss ${i.issues.length}`.padEnd(7),
      `pr ${i.pulls.filter((p) => !p.dependency).length}`.padEnd(6),
      `dep ${i.pulls.filter((p) => p.dependency).length}`.padEnd(7),
      `ci ${i.ci.status}`.padEnd(11),
      `rel ${i.latestRelease?.tag ?? "-"}+${i.commitsSinceRelease ?? "-"}`.padEnd(16),
      `wk ${i.weeklyCommits.join(",")}`.padEnd(40),
      `${a.score} ${a.band}`,
    ].join(" "),
  );
}
if (misses > 0) {
  console.error(`ABORT: replay could not answer ${misses} request(s)`);
  process.exit(4);
}

writeFileSync(new URL("../demo/snapshot.json", import.meta.url), text);
console.log(rows.join("\n"));
console.log(
  `\nrecorded ${Object.keys(responses).length} responses, ${(text.length / 1024).toFixed(0)} KiB, dropped ${dropped} third-party item(s), rate remaining ${client.rate.remaining}`,
);
