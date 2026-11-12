import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostAllowed, serveStatic } from "../src/server/node-adapter.ts";
import { parseLinkHeader } from "../src/github/link.ts";
import { MAX_TOTAL_ACTIONS_PER_REPO } from "../src/domain/store.ts";
import { makeApp, snapshot } from "./helpers.ts";

test("Host allow-list blocks DNS-rebinding names and accepts loopback", () => {
  assert.equal(hostAllowed("127.0.0.1:8787", 8787), true);
  assert.equal(hostAllowed("localhost:8787", 8787), true);
  assert.equal(hostAllowed("[::1]:8787", 8787), true);
  assert.equal(hostAllowed("attacker.example:8787", 8787), false, "rebound name keeps the attacker's Host");
  assert.equal(hostAllowed("localhost:9999", 8787), false, "wrong port");
  assert.equal(hostAllowed(undefined, 8787), false);
  assert.equal(hostAllowed("cc.internal", 8787, ["cc.internal"]), true, "explicit ALLOWED_HOSTS");
});

test("static server refuses dotfiles, dot-directories and traversal", async () => {
  const root = mkdtempSync(join(tmpdir(), "gcc-static-"));
  try {
    mkdirSync(join(root, ".data"));
    writeFileSync(join(root, ".data", "workspace.json"), "{}");
    writeFileSync(join(root, "index.html"), "<p>ok</p>");
    writeFileSync(join(root, "notes.md"), "not servable");
    assert.equal((await serveStatic(root, "/index.html", "GET"))?.status, 200);
    assert.equal(await serveStatic(root, "/.data/workspace.json", "GET"), null);
    assert.equal(await serveStatic(root, "/%2e%2e/%2e%2e/etc/hosts", "GET"), null);
    assert.equal(await serveStatic(root, "/notes.md", "GET"), null, "extension allow-list");
    assert.equal(await serveStatic(root, "/index.html", "POST"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Link header parsing stays linear on hostile input", () => {
  // Each ";  " segment lets the old (?:;\s*[^;]+)* split its spaces two ways; the trailing ";" forces full backtracking.
  const hostile = "<https://api.github.com/x>" + ";  ".repeat(24) + ";";
  const started = performance.now();
  parseLinkHeader(hostile);
  assert.ok(performance.now() - started < 50, "previous regex took ~669 ms at 24 segments and doubled per segment");
  assert.deepEqual(parseLinkHeader('<https://api.github.com/a?page=2>; foo="x"; rel="next"'), { next: "https://api.github.com/a?page=2" });
});

test("completed next actions count toward a per-repo total cap", async () => {
  const { call, app } = makeApp();
  const repo = snapshot.workspace[0]!.fullName;
  const store = app.services.store;
  const base = store.listActions(repo).length;
  for (let i = base; i < MAX_TOTAL_ACTIONS_PER_REPO; i++) {
    store.addAction({ id: `na_fill_${i}`, repo, title: "done item", dueOn: null, status: "done", createdAt: "", updatedAt: "" });
  }
  const res = await call("POST", `/api/v1/repos/${repo}/next-actions`, { body: { title: "one too many" } });
  assert.equal(res.status, 422);
});
