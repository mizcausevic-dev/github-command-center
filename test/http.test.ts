import { test } from "node:test";
import assert from "node:assert/strict";
import { ifMatchSatisfied, ifNoneMatchHits, parseEtagList, etagFor } from "../src/http/conditional.ts";
import { decodeCursor, encodeCursor, keyComparator, paginate, queryFingerprint, type PageParams } from "../src/http/pagination.ts";
import { parseLinkHeader } from "../src/github/link.ts";
import { RateLimiter } from "../src/http/ratelimit.ts";
import { IdempotencyStore } from "../src/http/idempotency.ts";
import { rules, validateObject } from "../src/http/body.ts";
import { ApiError } from "../src/http/problem.ts";

test("etag list parsing keeps quoted commas and weak prefixes", () => {
  assert.deepEqual(parseEtagList('"a,b", W/"c" , "d"'), ['"a,b"', 'W/"c"', '"d"']);
  assert.deepEqual(parseEtagList("*"), ["*"]);
});

test("If-None-Match uses weak comparison; If-Match uses strong comparison", async () => {
  const tag = await etagFor('{"x":1}');
  assert.equal(ifNoneMatchHits(`W/${tag}`, tag), true);
  assert.equal(ifNoneMatchHits('"other", ' + tag, tag), true);
  assert.equal(ifNoneMatchHits('"other"', tag), false);
  assert.equal(ifMatchSatisfied(tag, tag), true);
  assert.equal(ifMatchSatisfied(`W/${tag}`, tag), false, "weak tags never satisfy If-Match");
  assert.equal(ifMatchSatisfied("*", tag), true);
});

test("etag changes when any byte of the representation changes", async () => {
  assert.notEqual(await etagFor('{"priority":"P1"}'), await etagFor('{"priority":"P2"}'));
  assert.equal(await etagFor('{"a":1}'), await etagFor('{"a":1}'));
});

const params = (url: string, limit: number, after?: (string | number)[]): PageParams => ({ limit, after, fingerprint: queryFingerprint(new URL(url)) });

test("keyset pagination walks every item exactly once, stable under inserts", () => {
  const items = Array.from({ length: 23 }, (_, i) => ({ id: `r${String(i).padStart(2, "0")}`, score: i % 5 }));
  const key = (t: { id: string; score: number }) => [t.score, t.id];
  const cmp = keyComparator([-1, 1]);
  const seen: string[] = [];
  let after: (string | number)[] | undefined;
  for (let guard = 0; guard < 10; guard++) {
    const page = paginate(items, key, cmp, params("http://x/list?sort=s", 5, after));
    seen.push(...page.items.map((i) => i.id));
    if (guard === 1) items.push({ id: "r00a", score: 4 }); // insert before the cursor position
    if (!page.nextCursor) break;
    after = decodeCursor(page.nextCursor, queryFingerprint(new URL("http://x/list?sort=s")));
  }
  assert.equal(new Set(seen).size, seen.length, "no duplicates");
  assert.equal(seen.length, 23, "the item inserted behind the cursor is not served mid-walk");
});

test("cursor is bound to its query and rejects tampering", () => {
  const fp = queryFingerprint(new URL("http://x/repos?sort=name"));
  const cursor = encodeCursor(["abc"], fp);
  assert.deepEqual(decodeCursor(cursor, fp), ["abc"]);
  assert.throws(() => decodeCursor(cursor, queryFingerprint(new URL("http://x/repos?sort=-name"))), (e: ApiError) => e.type === "bad-cursor");
  assert.throws(() => decodeCursor("not*base64", fp), (e: ApiError) => e.status === 400);
  assert.throws(() => decodeCursor(Buffer.from('{"k":[{"$gt":1}],"q":"x"}').toString("base64url"), fp), (e: ApiError) => e.status === 400);
  assert.equal(
    queryFingerprint(new URL("http://x/r?b=2&a=1&cursor=z&limit=5")),
    queryFingerprint(new URL("http://x/r?a=1&b=2")),
    "fingerprint ignores paging params and param order",
  );
});

test("RFC 8288 link parsing handles GitHub pagination headers", () => {
  const h =
    '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=9>; rel="last"';
  assert.deepEqual(parseLinkHeader(h), {
    next: "https://api.github.com/repositories/1/issues?page=2",
    last: "https://api.github.com/repositories/1/issues?page=9",
  });
  assert.deepEqual(parseLinkHeader(null), {});
});

test("token bucket refills over time and reports Retry-After", () => {
  let t = 0;
  const rl = new RateLimiter({ capacity: 3, windowSec: 3, now: () => t });
  assert.equal(rl.take("a").ok, true);
  rl.take("a");
  rl.take("a");
  const denied = rl.take("a");
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterSec, 1);
  assert.equal(rl.take("b").ok, true, "buckets are per client");
  t = 1000;
  assert.equal(rl.take("a").ok, true);
  assert.match(rl.headers(denied)["ratelimit"] ?? "", /^"default";r=0;t=\d+$/);
});

test("idempotency store replays, rejects key reuse, and releases on failure", async () => {
  const store = new IdempotencyStore();
  let calls = 0;
  const handler = async () => {
    calls++;
    return new Response('{"ok":true}', { status: 201, headers: { location: "/x" } });
  };
  const first = await store.run("s", "key-12345", "fp1", handler);
  const replay = await store.run("s", "key-12345", "fp1", handler);
  assert.equal(calls, 1);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotent-replayed"), "true");
  assert.equal(first.headers.get("idempotent-replayed"), null);
  await assert.rejects(store.run("s", "key-12345", "fp2", handler), (e: ApiError) => e.type === "idempotency-mismatch");
  await assert.rejects(
    store.run("s", "key-boom-1", "fp", async () => {
      throw new Error("upstream down");
    }),
  );
  await store.run("s", "key-boom-1", "fp", handler);
  assert.equal(calls, 2, "a failed attempt does not poison the key");
  assert.throws(() => IdempotencyStore.validateKey("short"));
});

test("validator collects every field error with JSON Pointers and rejects unknown fields", () => {
  try {
    validateObject({ title: "x", dueOn: "2026-02-30", extra: 1 }, { title: { required: true, rule: rules.string({ min: 3, max: 10 }) }, dueOn: { rule: rules.date() } });
    assert.fail("should throw");
  } catch (e) {
    const err = e as ApiError;
    assert.equal(err.status, 422);
    assert.deepEqual(err.errors?.map((x) => x.pointer).sort(), ["/dueOn", "/extra", "/title"]);
  }
});
