import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, UpstreamError, type FetchLike } from "../src/github/client.ts";
import { snapshotFetch } from "../src/github/snapshot.ts";
import { snapshot, NOW } from "./helpers.ts";

const repoPath = `/repos/${snapshot.catalog[0]}`;

function client(fetch: FetchLike, now = () => NOW) {
  return new GitHubClient({ fetch, userAgent: "test", now, sleep: async () => {}, token: "test-token" });
}

test("conditional revalidation returns 304s that spend no rate-limit budget", async () => {
  let t = NOW;
  const upstream = snapshotFetch(snapshot, { now: () => t });
  const gh = client(upstream, () => t);
  await gh.get(repoPath);
  const afterFirst = upstream.remaining();
  t += 120_000; // past the fresh window
  const again = await gh.get(repoPath);
  assert.equal(again.source, "revalidated");
  assert.equal(upstream.remaining(), afterFirst, "a 304 must not consume budget");
  assert.equal(gh.stats.revalidated, 1);
  assert.equal(gh.rate.remaining, afterFirst);
});

test("fresh window serves from memory without touching the network", async () => {
  let calls = 0;
  const upstream = snapshotFetch(snapshot);
  const gh = client(async (u, i) => (calls++, upstream(u, i)));
  await gh.get(repoPath);
  const second = await gh.get(repoPath);
  assert.equal(second.source, "fresh");
  assert.equal(calls, 1);
  const forced = await gh.get(repoPath, { revalidate: true });
  assert.equal(forced.source, "revalidated", "Cache-Control: no-cache from the client forces revalidation");
  assert.equal(calls, 2);
});

test("identical concurrent requests are coalesced into one upstream call", async () => {
  let calls = 0;
  const upstream = snapshotFetch(snapshot, { latencyMs: 5 });
  const gh = client(async (u, i) => (calls++, upstream(u, i)));
  await Promise.all([gh.get(repoPath), gh.get(repoPath), gh.get(repoPath)]);
  assert.equal(calls, 1);
  assert.equal(gh.stats.coalesced, 2);
});

test("5xx is retried with backoff, then stale data is served if retries run out", async () => {
  let fail = false;
  let calls = 0;
  let t = NOW;
  const upstream = snapshotFetch(snapshot);
  const gh = client(async (u, i) => {
    calls++;
    if (fail) return new Response("{}", { status: 502 });
    return upstream(u, i);
  }, () => t);
  await gh.get(repoPath);
  fail = true;
  t += 120_000;
  const res = await gh.get(repoPath);
  assert.equal(res.source, "stale");
  assert.equal(calls, 1 + 3, "one initial call plus 1 try + 2 retries");
  assert.equal(gh.stats.retries, 2);
});

test("primary and secondary rate limits are classified with a usable retry delay", async () => {
  const primary = client(async () =>
    new Response('{"message":"API rate limit exceeded"}', {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 90) },
    }),
  );
  await assert.rejects(primary.get("/repos/a/b"), (e: UpstreamError) => e.kind === "rate-limited" && e.retryAfterSec === 90);

  const secondary = client(async () => new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403, headers: { "retry-after": "17" } }));
  await assert.rejects(secondary.get("/repos/a/b"), (e: UpstreamError) => e.kind === "rate-limited" && e.retryAfterSec === 17);

  const noHeader = client(async () => new Response('{"message":"You have exceeded a secondary rate limit"}', { status: 403 }));
  await assert.rejects(noHeader.get("/repos/a/b"), (e: UpstreamError) => e.retryAfterSec === 60, "no retry-after: wait at least a minute");

  const forbidden = client(async () => new Response('{"message":"Resource not accessible"}', { status: 403 }));
  await assert.rejects(forbidden.get("/repos/a/b"), (e: UpstreamError) => e.kind === "forbidden");
});

test("pagination follows Link headers but refuses to leave the API origin", async () => {
  const gh = client(async (url) => {
    const page = new URL(url).searchParams.get("page") ?? "1";
    const link = page === "1" ? '<https://api.github.com/repos/a/b/issues?page=2>; rel="next"' : '<https://evil.example/steal?page=3>; rel="next"';
    return new Response(JSON.stringify([{ n: page }]), { headers: { link, "content-type": "application/json" } });
  });
  await assert.rejects(gh.paginate("/repos/a/b/issues", { maxPages: 5 }), (e: UpstreamError) => /outside/.test(e.message));
});

test("bearer token is sent and webhook invalidation drops only that repo's entries", async () => {
  const seen: string[] = [];
  const upstream = snapshotFetch(snapshot);
  const gh = client(async (u, i) => {
    seen.push(new Headers(i?.headers).get("authorization") ?? "");
    return upstream(u, i);
  });
  await gh.get(repoPath);
  await gh.get(`/repos/${snapshot.catalog[1]}`);
  assert.equal(seen[0], "Bearer test-token");
  assert.equal(gh.invalidateRepo(snapshot.catalog[0]!.toUpperCase()), 1, "case-insensitive");
  assert.equal(gh.cacheSize, 1);
});
