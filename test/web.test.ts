import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../web/src/api-client.ts";
import { html, safeGithubUrl, escapeHtml } from "../web/src/html.ts";
import { makeApp } from "./helpers.ts";

test("dashboard client always sends an explicit Cache-Control so browsers cannot force upstream revalidation", async () => {
  const seen: string[] = [];
  const { app, github } = makeApp();
  const client = new ApiClient(async (req) => {
    seen.push(req.headers.get("cache-control") ?? "(none)");
    return app.handle(req);
  }, "https://command-center.demo");
  await client.get("/api/v1/attention");
  const second = await client.get("/api/v1/attention");
  assert.deepEqual(seen, ["max-age=60", "max-age=60"]);
  assert.equal(github.stats.revalidated, 0, "ordinary reads stay inside the fresh window");
  assert.ok(second.data, "a 304 returns the cached body to the caller");
  await client.get("/api/v1/attention", { revalidate: true });
  assert.equal(seen.at(-1), "no-cache");
  assert.ok(github.stats.revalidated > 0, "the Revalidate button does reach GitHub with conditional requests");
});

test("client reports 304s from its own ETag cache to the inspector", async () => {
  const { app } = makeApp();
  const statuses: number[] = [];
  const client = new ApiClient((req) => app.handle(req), "https://command-center.demo");
  client.onExchange((e) => statuses.push(e.status));
  await client.get("/api/v1/repos?limit=5");
  await client.get("/api/v1/repos?limit=5");
  assert.deepEqual(statuses, [200, 304]);
});

test("html template escapes interpolated GitHub text", () => {
  const title = `<img src=x onerror="alert(1)">`;
  const out = html`<td title="${title}">${title}</td>`.value;
  assert.ok(!out.includes("<img"));
  assert.ok(out.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.equal(escapeHtml("`'"), "&#96;&#39;");
});

test("only https github.com links are rendered as hrefs", () => {
  assert.equal(safeGithubUrl("javascript:alert(1)"), "#");
  assert.equal(safeGithubUrl("https://evil.example/github.com"), "#");
  assert.equal(safeGithubUrl("http://github.com/a/b"), "#");
  assert.equal(safeGithubUrl("https://github.com/a/b/issues/1"), "https://github.com/a/b/issues/1");
});
