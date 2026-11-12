import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeApp, problemOf, typeOf, snapshot } from "./helpers.ts";

const first = snapshot.workspace[0]!.fullName;
const firstPath = `/api/v1/repos/${first}`;
const untracked = snapshot.catalog.find((c) => !snapshot.workspace.some((w) => w.fullName === c))!;

test("attention endpoint ranks repos and summarizes the portfolio", async () => {
  const { call } = makeApp();
  const res = await call("GET", "/api/v1/attention?limit=5");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { summary: { tracked: number }; queue: Array<{ attention: { score: number } }> };
  assert.equal(body.summary.tracked, snapshot.workspace.length);
  const scores = body.queue.map((q) => q.attention.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "queue is sorted by score");
  assert.ok(body.queue.length <= 5);
});

test("conditional GET: ETag round-trip yields 304 with no body", async () => {
  const { call } = makeApp();
  const a = await call("GET", "/api/v1/repos?limit=3");
  const tag = a.headers.get("etag")!;
  assert.match(tag, /^"[A-Za-z0-9_-]+"$/);
  const b = await call("GET", "/api/v1/repos?limit=3", { headers: { "if-none-match": tag } });
  assert.equal(b.status, 304);
  assert.equal(await b.text(), "");
  assert.equal(b.headers.get("etag"), tag);
});

test("Link header walks the full list without gaps or repeats", async () => {
  const { call } = makeApp();
  const seen: string[] = [];
  let next: string | null = "/api/v1/repos?limit=4&sort=name";
  while (next) {
    const res = await call("GET", next);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: Array<{ fullName: string }> };
    seen.push(...body.data.map((d) => d.fullName));
    next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
  }
  assert.equal(seen.length, snapshot.workspace.length);
  assert.deepEqual(seen, [...seen].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())));
});

test("a cursor replayed against a different sort is rejected", async () => {
  const { call } = makeApp();
  const res = await call("GET", "/api/v1/repos?limit=2&sort=name");
  const cursor = ((await res.json()) as { page: { nextCursor: string } }).page.nextCursor;
  const bad = await call("GET", `/api/v1/repos?limit=2&sort=-name&cursor=${cursor}`);
  assert.equal(bad.status, 400);
  assert.equal(typeOf((await problemOf(bad)).type), "bad-cursor");
});

test("unknown query parameters and bad enum values fail loudly", async () => {
  const { call } = makeApp();
  assert.equal(typeOf((await problemOf(await call("GET", "/api/v1/repos?sotr=name"))).type), "bad-request");
  assert.equal((await call("GET", "/api/v1/repos?sort=stars")).status, 400);
  assert.equal((await call("GET", "/api/v1/repos?limit=0")).status, 400);
  const filtered = (await (await call("GET", "/api/v1/repos?band=critical")).json()) as { data: Array<{ attention: { band: string } }> };
  assert.ok(filtered.data.every((d) => d.attention.band === "critical"));
});

test("settings PATCH enforces optimistic concurrency (428, 412, 200)", async () => {
  const { call } = makeApp();
  const get = await call("GET", `${firstPath}/settings`);
  const tag = get.headers.get("etag")!;
  const patch = (headers: Record<string, string>, body: unknown) =>
    call("PATCH", `${firstPath}/settings`, { headers: { "content-type": "application/merge-patch+json", ...headers }, body });

  assert.equal((await patch({}, { priority: "P1" })).status, 428);
  const ok = await patch({ "if-match": tag }, { priority: "P1", notes: null });
  assert.equal(ok.status, 200);
  const updated = (await ok.json()) as { priority: string; notes: string };
  assert.equal(updated.priority, "P1");
  assert.equal(updated.notes, "", "null clears a field in JSON Merge Patch");
  const newTag = ok.headers.get("etag")!;
  assert.notEqual(newTag, tag);

  const stale = await patch({ "if-match": tag }, { priority: "P3" });
  assert.equal(stale.status, 412, "a client holding the old ETag cannot overwrite");
  assert.equal(stale.headers.get("etag"), newTag, "412 tells the client the current ETag");
  const invalid = await patch({ "if-match": newTag }, { priority: "P9", colour: "red" });
  assert.equal(invalid.status, 422);
  assert.deepEqual((await problemOf(invalid)).errors?.map((e) => e.pointer).sort(), ["/colour", "/priority"]);
  assert.equal((await patch({ "if-match": newTag, "content-type": "text/plain" }, {})).status, 415);
});

test("connect repo: 201 + Location, 409 duplicate, 422 unknown, idempotent replay", async () => {
  const { call } = makeApp();
  const key = { "idempotency-key": "connect-0001-abcdef" };
  const created = await call("POST", "/api/v1/repos", { headers: key, body: { fullName: untracked, priority: "P1" } });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("location"), `/api/v1/repos/${untracked}`);

  const replay = await call("POST", "/api/v1/repos", { headers: key, body: { fullName: untracked, priority: "P1" } });
  assert.equal(replay.status, 201, "a retried POST replays the first response");
  assert.equal(replay.headers.get("idempotent-replayed"), "true");

  const reused = await call("POST", "/api/v1/repos", { headers: key, body: { fullName: untracked, priority: "P2" } });
  assert.equal(typeOf((await problemOf(reused)).type), "idempotency-mismatch");

  const dup = await call("POST", "/api/v1/repos", { body: { fullName: untracked.toUpperCase() } });
  assert.equal(dup.status, 409, "names are case-insensitive like GitHub's");
  assert.equal(dup.headers.get("location"), `/api/v1/repos/${untracked}`);

  const unknown = await call("POST", "/api/v1/repos", { body: { fullName: "mizcausevic-dev/does-not-exist-here" } });
  assert.equal(unknown.status, 422);
  assert.match((await problemOf(unknown)).errors![0]!.detail, /not found/);

  const bad = await call("POST", "/api/v1/repos", { body: { fullName: "../../etc" } });
  assert.equal(bad.status, 422);
});

test("disconnect cascades to next actions", async () => {
  const { call, app } = makeApp();
  assert.ok(app.services.store.listActions(first).length > 0);
  assert.equal((await call("DELETE", firstPath)).status, 204);
  assert.equal(app.services.store.listActions(first).length, 0);
  assert.equal((await call("GET", firstPath)).status, 404);
});

test("next actions: create, conditional update, complete, delete", async () => {
  const { call } = makeApp();
  const created = await call("POST", `${firstPath}/next-actions`, { body: { title: "Ship the fix", dueOn: "2026-11-20" } });
  assert.equal(created.status, 201);
  const action = (await created.json()) as { id: string; links: { self: string } };
  assert.equal(created.headers.get("location"), action.links.self);
  const tag = created.headers.get("etag")!;

  assert.equal((await call("PATCH", action.links.self, { body: { status: "done" } })).status, 428);
  const done = await call("PATCH", action.links.self, { headers: { "if-match": tag }, body: { status: "done" } });
  assert.equal(done.status, 200);
  assert.equal(((await done.json()) as { status: string }).status, "done");

  const open = (await (await call("GET", `${firstPath}/next-actions`)).json()) as { data: Array<{ id: string }> };
  assert.ok(!open.data.some((a) => a.id === action.id), "default filter is status=open");
  assert.equal((await call("DELETE", action.links.self, { headers: { "if-match": tag } })).status, 412);
  assert.equal((await call("DELETE", action.links.self)).status, 204);
  assert.equal((await call("GET", action.links.self)).status, 404);
  assert.equal((await call("POST", `${firstPath}/next-actions`, { body: { title: "x", dueOn: "2026-13-01" } })).status, 422);
});

test("HTTP semantics: 404, 405 + Allow, OPTIONS, HEAD, 406, path traversal", async () => {
  const { call } = makeApp();
  const missing = await call("GET", "/api/v1/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "application/problem+json");

  const wrong = await call("PUT", "/api/v1/repos");
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get("allow"), "GET, HEAD, OPTIONS, POST");

  const options = await call("OPTIONS", firstPath);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("allow"), "DELETE, GET, HEAD, OPTIONS");

  const head = await call("HEAD", "/api/v1/attention");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.ok(head.headers.get("etag"));

  assert.equal((await call("GET", "/api/v1/attention", { headers: { accept: "text/html" } })).status, 406);
  assert.equal((await call("GET", "/api/v1/attention", { headers: { accept: "text/html, application/json;q=0.9" } })).status, 200);
  assert.equal((await call("GET", "/api/v1/repos/mizcausevic-dev/..%2F..%2Fuser")).status, 404);
  assert.equal((await call("GET", "/api/v1/repos/mizcausevic-dev/a%2Fb")).status, 404, "an encoded slash cannot smuggle a path into the GitHub URL");
});

test("every error carries a request id and stable problem type", async () => {
  const { call } = makeApp();
  const res = await call("GET", "/api/v1/repos/a/b", { headers: { "x-request-id": "trace-123" } });
  const p = (await problemOf(res)) as unknown as { requestId: string; instance: string; type: string };
  assert.equal(res.headers.get("x-request-id"), "trace-123");
  assert.equal(p.requestId, "trace-123");
  assert.equal(p.instance, "/api/v1/repos/a/b");
  assert.match(p.type, /^https:\/\/github\.com\/.+docs\/errors\.md#not-found$/);
});

test("bearer auth guards the API when API_TOKEN is set", async () => {
  const { call } = makeApp({ apiToken: "s3cret-token-value" });
  const anon = await call("GET", "/api/v1/attention");
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get("www-authenticate"), 'Bearer realm="command-center"');
  assert.equal((await call("GET", "/api/v1/attention", { headers: { authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call("GET", "/api/v1/attention", { headers: { authorization: "Bearer s3cret-token-value" } })).status, 200);
});

test("rate limiting returns 429 with Retry-After and RateLimit headers", async () => {
  const { call } = makeApp({ rateLimit: { capacity: 2, windowSec: 60 } });
  const a = await call("GET", "/api/v1");
  assert.match(a.headers.get("ratelimit") ?? "", /r=1/);
  await call("GET", "/api/v1");
  const limited = await call("GET", "/api/v1");
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  assert.equal(limited.headers.get("ratelimit-policy"), '"default";q=2;w=60');
});

test("client Cache-Control: no-cache revalidates upstream with conditional requests", async () => {
  const { call, github, upstream } = makeApp();
  await call("GET", "/api/v1/attention");
  const budget = upstream.remaining();
  const res = await call("GET", "/api/v1/attention", { headers: { "cache-control": "no-cache" } });
  assert.equal(res.status, 200);
  assert.ok(github.stats.revalidated > 0, "upstream answered with 304s");
  assert.equal(upstream.remaining(), budget, "revalidation spent no budget");
  const meta = (await (await call("GET", "/api/v1/meta/upstream")).json()) as { github: { budgetSaved: number } };
  assert.ok(meta.github.budgetSaved >= github.stats.revalidated);
});

test("webhook: HMAC verified, de-duplicated by delivery id, invalidates cache", async () => {
  const secret = "whsec-test-value";
  const { call, github } = makeApp({ webhookSecret: secret });
  await call("GET", firstPath);
  const before = github.cacheSize;
  const raw = JSON.stringify({ action: "opened", repository: { full_name: first } });
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const headers = { "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": "d-1", "x-hub-signature-256": sig };

  const ok = await call("POST", "/api/v1/webhooks/github", { headers, raw });
  assert.equal(ok.status, 202);
  assert.ok(github.cacheSize < before, "cached entries for the repo were dropped");
  assert.equal((await call("POST", "/api/v1/webhooks/github", { headers, raw })).status, 200, "duplicate delivery");

  const forged = await call("POST", "/api/v1/webhooks/github", { headers: { ...headers, "x-github-delivery": "d-2" }, raw: raw.replace("opened", "closed") });
  assert.equal(forged.status, 401);
  const noSecret = makeApp();
  assert.equal((await noSecret.call("POST", "/api/v1/webhooks/github", { headers, raw })).status, 503);
});

test("issues endpoint filters by type and paginates", async () => {
  const { call } = makeApp();
  const deps = (await (await call("GET", `${firstPath}/issues?type=dependency&limit=5`)).json()) as {
    data: Array<{ dependency: boolean; ageDays: number }>;
    total: number;
    page: { nextCursor: string | null };
  };
  assert.ok(deps.data.every((d) => d.dependency));
  assert.ok(deps.data.every((d) => d.ageDays >= 0));
  if (deps.total > 5) assert.ok(deps.page.nextCursor);
});
