// The attention model: a transparent, additive score from 0 to 100.
//
// Every point is traceable to a named signal with a human-readable reason,
// so the dashboard can answer "why is this repo at the top?" instead of
// presenting an opaque number. Weights are constants in one table; tests pin
// each signal's behavior. See docs/scoring.md for the rationale per weight.

import type { RepoInsight } from "./insights.ts";
import type { NextAction, TrackedRepo } from "./store.ts";

const DAY = 86_400_000;

export type SignalId =
  | "ci_failing"
  | "release_drift"
  | "review_queue"
  | "issue_backlog"
  | "dependency_backlog"
  | "dormant"
  | "owner_priority"
  | "action_due";

/** Signals roll up into four groups for charts (validated 4-color order). */
export type SignalGroup = "delivery" | "review" | "maintenance" | "owner";

export const SIGNAL_GROUP: Record<SignalId, SignalGroup> = {
  ci_failing: "delivery",
  release_drift: "delivery",
  review_queue: "review",
  issue_backlog: "review",
  dependency_backlog: "maintenance",
  dormant: "maintenance",
  owner_priority: "owner",
  action_due: "owner",
};

export interface Signal {
  id: SignalId;
  group: SignalGroup;
  points: number;
  reason: string;
}

export type Band = "critical" | "high" | "watch" | "healthy" | "archived";

export interface Attention {
  score: number;
  band: Band;
  signals: Signal[];
}

export const WEIGHTS = {
  ciFailing: 30,
  reviewPerPr: 6,
  reviewCap: 24,
  reviewMinAgeDays: 3,
  unansweredPerIssue: 5,
  staleIssuePerIssue: 2,
  issueCap: 25,
  unansweredMinAgeDays: 3,
  staleIssueAgeDays: 30,
  dependencyPerPr: 2,
  dependencyCap: 12,
  dependencyOldBonus: 6,
  dependencyOldDays: 30,
  dormantDays: 45,
  dormantPoints: 10,
  abandonedDays: 120,
  abandonedPoints: 15,
  releaseDriftCommits: 15,
  releaseDriftPoints: 8,
  releaseDriftHeavyCommits: 50,
  releaseDriftHeavyPoints: 12,
  priority: { P0: 25, P1: 15, P2: 5, P3: 0 },
  overduePerAction: 12,
  overdueCap: 24,
  dueSoonPerAction: 4,
  dueSoonCap: 8,
  dueSoonDays: 2,
} as const;

export const BANDS: Array<{ band: Exclude<Band, "archived">; min: number }> = [
  { band: "critical", min: 60 },
  { band: "high", min: 35 },
  { band: "watch", min: 15 },
  { band: "healthy", min: 0 },
];

const ageDays = (iso: string, now: number) => Math.floor((now - Date.parse(iso)) / DAY);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function scoreRepo(insight: RepoInsight, tracked: TrackedRepo, actions: NextAction[], now: number): Attention {
  if (insight.archived) {
    return { score: 0, band: "archived", signals: [] };
  }
  const signals: Signal[] = [];
  const add = (id: SignalId, points: number, reason: string) => {
    if (points > 0) signals.push({ id, group: SIGNAL_GROUP[id], points, reason });
  };

  if (insight.ci.status === "failing") {
    const names = insight.ci.failingWorkflows;
    const list = names.slice(0, 3).map((n) => (n.length > 40 ? n.slice(0, 39) + "…" : n)).join(", ") + (names.length > 3 ? ` +${names.length - 3} more` : "");
    add("ci_failing", WEIGHTS.ciFailing, `CI failing on ${insight.defaultBranch}: ${list}`);
  }

  const humanPrs = insight.pulls.filter((p) => !p.isBot && !p.draft && ageDays(p.createdAt, now) >= WEIGHTS.reviewMinAgeDays);
  if (humanPrs.length > 0) {
    const oldest = Math.max(...humanPrs.map((p) => ageDays(p.createdAt, now)));
    add(
      "review_queue",
      Math.min(WEIGHTS.reviewCap, humanPrs.length * WEIGHTS.reviewPerPr),
      `${plural(humanPrs.length, "pull request")} waiting on review (oldest ${oldest}d)`,
    );
  }

  const humanIssues = insight.issues;
  const unanswered = humanIssues.filter((i) => i.comments === 0 && ageDays(i.createdAt, now) >= WEIGHTS.unansweredMinAgeDays);
  const stale = humanIssues.filter((i) => (i.comments ?? 0) > 0 && ageDays(i.updatedAt, now) >= WEIGHTS.staleIssueAgeDays);
  const issuePoints = unanswered.length * WEIGHTS.unansweredPerIssue + stale.length * WEIGHTS.staleIssuePerIssue;
  if (issuePoints > 0) {
    const parts = [];
    if (unanswered.length) parts.push(`${plural(unanswered.length, "issue")} with no reply`);
    if (stale.length) parts.push(`${stale.length} quiet for ${WEIGHTS.staleIssueAgeDays}+ days`);
    add("issue_backlog", Math.min(WEIGHTS.issueCap, issuePoints), parts.join(", "));
  }

  const deps = insight.pulls.filter((p) => p.dependency);
  if (deps.length > 0) {
    const oldest = Math.max(...deps.map((p) => ageDays(p.createdAt, now)));
    const bonus = oldest >= WEIGHTS.dependencyOldDays ? WEIGHTS.dependencyOldBonus : 0;
    add(
      "dependency_backlog",
      Math.min(WEIGHTS.dependencyCap, deps.length * WEIGHTS.dependencyPerPr) + bonus,
      `${plural(deps.length, "dependency update")} open (oldest ${oldest}d)`,
    );
  }

  const openWork = insight.issues.length + insight.pulls.length;
  const lastActivity = insight.lastCommitAt ?? insight.pushedAt;
  if (openWork > 0 && lastActivity) {
    const idle = ageDays(lastActivity, now);
    if (idle >= WEIGHTS.abandonedDays) add("dormant", WEIGHTS.abandonedPoints, `no commits for ${idle} days with ${plural(openWork, "open item")}`);
    else if (idle >= WEIGHTS.dormantDays) add("dormant", WEIGHTS.dormantPoints, `no commits for ${idle} days with ${plural(openWork, "open item")}`);
  }

  const drift = insight.commitsSinceRelease;
  if (insight.latestRelease && drift !== null) {
    if (drift >= WEIGHTS.releaseDriftHeavyCommits) {
      add("release_drift", WEIGHTS.releaseDriftHeavyPoints, `${drift} commits since ${insight.latestRelease.tag}`);
    } else if (drift >= WEIGHTS.releaseDriftCommits) {
      add("release_drift", WEIGHTS.releaseDriftPoints, `${drift} commits since ${insight.latestRelease.tag}`);
    }
  }

  add("owner_priority", WEIGHTS.priority[tracked.priority], `owner priority ${tracked.priority}`);

  const today = new Date(now).toISOString().slice(0, 10);
  const soonLimit = new Date(now + WEIGHTS.dueSoonDays * DAY).toISOString().slice(0, 10);
  const open = actions.filter((a) => a.status === "open" && a.dueOn);
  const overdue = open.filter((a) => (a.dueOn as string) < today);
  const dueSoon = open.filter((a) => (a.dueOn as string) >= today && (a.dueOn as string) <= soonLimit);
  const duePoints =
    Math.min(WEIGHTS.overdueCap, overdue.length * WEIGHTS.overduePerAction) + Math.min(WEIGHTS.dueSoonCap, dueSoon.length * WEIGHTS.dueSoonPerAction);
  if (duePoints > 0) {
    const parts = [];
    if (overdue.length) parts.push(`${plural(overdue.length, "next action")} overdue`);
    if (dueSoon.length) parts.push(`${dueSoon.length} due within ${WEIGHTS.dueSoonDays} days`);
    add("action_due", duePoints, parts.join(", "));
  }

  signals.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  const score = Math.min(100, signals.reduce((sum, s) => sum + s.points, 0));
  const band = BANDS.find((b) => score >= b.min)?.band ?? "healthy";
  return { score, band, signals };
}

export function overdueCount(actions: NextAction[], now: number): number {
  const today = new Date(now).toISOString().slice(0, 10);
  return actions.filter((a) => a.status === "open" && a.dueOn !== null && a.dueOn < today).length;
}
