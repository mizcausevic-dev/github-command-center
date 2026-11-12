import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreRepo, WEIGHTS } from "../src/domain/attention.ts";
import type { RepoInsight, WorkItem } from "../src/domain/insights.ts";
import type { NextAction, TrackedRepo } from "../src/domain/store.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function insight(over: Partial<RepoInsight> = {}): RepoInsight {
  return {
    fullName: "o/r", htmlUrl: "https://github.com/o/r", description: null, language: "TypeScript", topics: [], stars: 0, forks: 0,
    defaultBranch: "main", archived: false, isPrivate: false, pushedAt: daysAgo(1), issues: [], pulls: [], listsTruncated: false,
    ci: { status: "passing", failingWorkflows: [], lastRunAt: daysAgo(1), url: null, recent: [] },
    latestRelease: null, commitsSinceRelease: null, weeklyCommits: new Array(26).fill(0), lastCommitAt: daysAgo(1), events: [],
    fetchedAt: new Date(NOW).toISOString(), ...over,
  };
}
const tracked = (priority: TrackedRepo["priority"] = "P3"): TrackedRepo => ({ fullName: "o/r", priority, notes: "", pinned: false, connectedAt: "", updatedAt: "" });
const item = (over: Partial<WorkItem>): WorkItem => ({
  number: 1, kind: "pr", title: "t", author: "dev", isBot: false, dependency: false, draft: false, labels: [], comments: 0, reviewers: [],
  createdAt: daysAgo(10), updatedAt: daysAgo(10), htmlUrl: "", ...over,
});
const action = (dueOn: string | null, status: NextAction["status"] = "open"): NextAction => ({ id: "na_x", repo: "o/r", title: "t", dueOn, status, createdAt: "", updatedAt: "" });

test("a quiet, green, P3 repo is healthy with no signals", () => {
  const a = scoreRepo(insight(), tracked(), [], NOW);
  assert.equal(a.score, 0);
  assert.equal(a.band, "healthy");
  assert.deepEqual(a.signals, []);
});

test("failing CI alone puts a repo in the watch band and names the workflow", () => {
  const a = scoreRepo(insight({ ci: { status: "failing", failingWorkflows: ["ci"], lastRunAt: null, url: null, recent: [] } }), tracked(), [], NOW);
  assert.equal(a.score, WEIGHTS.ciFailing);
  assert.equal(a.band, "watch");
  assert.match(a.signals[0]!.reason, /CI failing on main: ci/);
});

test("review queue counts non-draft human PRs older than the minimum age, capped", () => {
  const pulls = [
    ...Array.from({ length: 6 }, (_, i) => item({ number: i })),
    item({ number: 90, draft: true }),
    item({ number: 91, createdAt: daysAgo(1) }),
    item({ number: 92, isBot: true, dependency: true }),
  ];
  const s = scoreRepo(insight({ pulls }), tracked(), [], NOW).signals.find((x) => x.id === "review_queue");
  assert.equal(s?.points, WEIGHTS.reviewCap);
  assert.match(s!.reason, /^6 pull requests waiting/);
});

test("dependency backlog adds a bonus once the oldest update passes 30 days", () => {
  const young = scoreRepo(insight({ pulls: [item({ isBot: true, dependency: true, createdAt: daysAgo(5) })] }), tracked(), [], NOW);
  const old = scoreRepo(insight({ pulls: [item({ isBot: true, dependency: true, createdAt: daysAgo(40) })] }), tracked(), [], NOW);
  assert.equal(young.signals[0]?.points, WEIGHTS.dependencyPerPr);
  assert.equal(old.signals[0]?.points, WEIGHTS.dependencyPerPr + WEIGHTS.dependencyOldBonus);
});

test("unanswered and stale issues combine into one capped backlog signal", () => {
  const issues = [item({ kind: "issue", comments: 0 }), item({ kind: "issue", comments: 3, updatedAt: daysAgo(45) })];
  const s = scoreRepo(insight({ issues }), tracked(), [], NOW).signals[0]!;
  assert.equal(s.id, "issue_backlog");
  assert.equal(s.points, WEIGHTS.unansweredPerIssue + WEIGHTS.staleIssuePerIssue);
});

test("dormancy only counts when there is open work", () => {
  const quiet = insight({ lastCommitAt: daysAgo(200), pushedAt: daysAgo(200) });
  assert.equal(scoreRepo(quiet, tracked(), [], NOW).score, 0, "finished project, nothing open");
  const withWork = { ...quiet, issues: [item({ kind: "issue", comments: 1, updatedAt: daysAgo(1) })] };
  const s = scoreRepo(withWork, tracked(), [], NOW).signals.find((x) => x.id === "dormant");
  assert.equal(s?.points, WEIGHTS.abandonedPoints);
});

test("release drift has two thresholds", () => {
  const rel = { tag: "v1", publishedAt: daysAgo(30), url: "" };
  assert.equal(scoreRepo(insight({ latestRelease: rel, commitsSinceRelease: 14 }), tracked(), [], NOW).score, 0);
  assert.equal(scoreRepo(insight({ latestRelease: rel, commitsSinceRelease: 15 }), tracked(), [], NOW).score, WEIGHTS.releaseDriftPoints);
  assert.equal(scoreRepo(insight({ latestRelease: rel, commitsSinceRelease: 50 }), tracked(), [], NOW).score, WEIGHTS.releaseDriftHeavyPoints);
});

test("owner priority and overdue next actions raise the score; done actions do not", () => {
  const a = scoreRepo(insight(), tracked("P0"), [action("2026-11-10"), action("2026-11-13"), action("2026-11-01", "done"), action(null)], NOW);
  const byId = Object.fromEntries(a.signals.map((s) => [s.id, s.points]));
  assert.equal(byId["owner_priority"], WEIGHTS.priority.P0);
  assert.equal(byId["action_due"], WEIGHTS.overduePerAction + WEIGHTS.dueSoonPerAction);
});

test("score is clamped at 100, bands follow thresholds, archived repos are muted", () => {
  const loud = insight({
    ci: { status: "failing", failingWorkflows: ["ci"], lastRunAt: null, url: null, recent: [] },
    pulls: Array.from({ length: 10 }, (_, i) => item({ number: i })),
    issues: Array.from({ length: 10 }, (_, i) => item({ kind: "issue", number: 100 + i })),
  });
  const a = scoreRepo(loud, tracked("P0"), [action("2026-01-01"), action("2026-01-02")], NOW);
  assert.equal(a.score, 100);
  assert.equal(a.band, "critical");
  assert.equal(scoreRepo({ ...loud, archived: true }, tracked("P0"), [], NOW).band, "archived");
  const sum = a.signals.reduce((x, s) => x + s.points, 0);
  assert.ok(sum > 100, "raw sum exceeds the clamp");
});
