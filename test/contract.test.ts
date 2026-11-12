import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openApiDocument } from "../src/api/openapi.ts";
import { sanitizeResponse, findEmails } from "../src/github/sanitize.ts";
import { makeApp, snapshot } from "./helpers.ts";

test("every routed operation is in the OpenAPI document and vice versa", () => {
  const { app } = makeApp();
  const doc = openApiDocument() as { paths: Record<string, Record<string, { operationId?: string }>> };
  const routed = app.router
    .list()
    .map((r) => `${r.method} ${r.pattern.replace(/:([a-z]+)/gi, "{$1}")} ${r.operationId}`)
    .sort();
  const documented = Object.entries(doc.paths)
    .flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([m]) => ["get", "post", "patch", "put", "delete"].includes(m))
        .map(([m, op]) => `${m.toUpperCase()} ${path} ${op.operationId}`),
    )
    .sort();
  assert.deepEqual(routed, documented);
});

test("every problem type the code can emit is documented in docs/errors.md", () => {
  const docs = readFileSync(new URL("../docs/errors.md", import.meta.url), "utf8");
  const src = readFileSync(new URL("../src/http/problem.ts", import.meta.url), "utf8");
  const union = /export type ProblemType =([\s\S]*?);/.exec(src)![1]!;
  const types = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(types.length > 10);
  for (const t of types) assert.match(docs, new RegExp(`^## ${t}$`, "m"), `docs/errors.md is missing ## ${t}`);
});

test("sanitizer drops commit author e-mails and refuses unknown endpoints", () => {
  const raw = [
    { sha: "abc", html_url: "u", commit: { author: { name: "Dev", email: "dev@example.com", date: "2026-01-01T00:00:00Z" }, message: "fix\n\nbody" }, author: { login: "dev", avatar_url: "x" } },
  ];
  const clean = JSON.stringify(sanitizeResponse("/repos/o/r/commits", raw));
  assert.deepEqual(findEmails(clean), []);
  assert.ok(!clean.includes("avatar_url"));
  assert.ok(!clean.includes("body"), "only the first line of the message is kept");
  assert.deepEqual(findEmails(JSON.stringify(raw)), ["dev@example.com"], "the scanner finds a planted positive");
  assert.throws(() => sanitizeResponse("/user/emails", []));
});

test("the committed demo snapshot is public-only and e-mail free", () => {
  const text = readFileSync(new URL("../demo/snapshot.json", import.meta.url), "utf8");
  assert.deepEqual(findEmails(text), []);
  const repoEntries = Object.entries(snapshot.responses).filter(([k]) => /^\/repos\/[^/]+\/[^/?]+$/.test(k));
  assert.equal(repoEntries.length, snapshot.catalog.length);
  for (const [, e] of repoEntries) assert.equal((e.body as { private: boolean }).private, false);
});
