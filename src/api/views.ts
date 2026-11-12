// Representations: the JSON shapes clients see. Kept separate from routes so
// list, detail and attention endpoints render a repository the same way.

import { scoreRepo, overdueCount, type Attention } from "../domain/attention.ts";
import type { RepoInsight } from "../domain/insights.ts";
import type { NextAction, TrackedRepo } from "../domain/store.ts";
import { UpstreamError } from "../github/client.ts";
import { mapPool, repoPath, type Services } from "./deps.ts";

export interface RepoView {
  tracked: TrackedRepo;
  insight: RepoInsight | null;
  attention: Attention | null;
  actions: NextAction[];
  error: { kind: string; detail: string } | null;
}

export async function loadView(s: Services, tracked: TrackedRepo, revalidate: boolean): Promise<RepoView> {
  const actions = s.store.listActions(tracked.fullName);
  try {
    const insight = await s.insights.load(tracked.fullName, revalidate);
    return { tracked, insight, attention: scoreRepo(insight, tracked, actions, s.now()), actions, error: null };
  } catch (err) {
    // One broken repo (deleted, renamed, token lost access) must not take the
    // whole dashboard down; it renders as an item with an error instead.
    if (err instanceof UpstreamError && err.kind !== "rate-limited") {
      return { tracked, insight: null, attention: null, actions, error: { kind: err.kind, detail: err.message } };
    }
    throw err;
  }
}

export async function loadAllViews(s: Services, revalidate: boolean): Promise<RepoView[]> {
  return mapPool(s.store.listRepos(), 4, (t) => loadView(s, t, revalidate));
}

export function settingsBody(t: TrackedRepo) {
  return {
    fullName: t.fullName,
    priority: t.priority,
    notes: t.notes,
    pinned: t.pinned,
    connectedAt: t.connectedAt,
    updatedAt: t.updatedAt,
    links: { self: `${repoPath(t.fullName)}/settings`, repo: repoPath(t.fullName) },
  };
}

export function repoSummary(v: RepoView, now: number) {
  const i = v.insight;
  const base = repoPath(v.tracked.fullName);
  return {
    fullName: v.tracked.fullName,
    priority: v.tracked.priority,
    pinned: v.tracked.pinned,
    description: i?.description ?? null,
    language: i?.language ?? null,
    htmlUrl: i?.htmlUrl ?? `https://github.com/${v.tracked.fullName}`,
    attention: v.attention,
    counts: i
      ? {
          openIssues: i.issues.length,
          openPulls: i.pulls.filter((p) => !p.dependency).length,
          dependencyPulls: i.pulls.filter((p) => p.dependency).length,
          openNextActions: v.actions.filter((a) => a.status === "open").length,
          overdueNextActions: overdueCount(v.actions, now),
        }
      : null,
    ci: i ? { status: i.ci.status, failingWorkflows: i.ci.failingWorkflows, lastRunAt: i.ci.lastRunAt, url: i.ci.url } : null,
    lastCommitAt: i?.lastCommitAt ?? null,
    pushedAt: i?.pushedAt ?? null,
    weeklyCommits: i?.weeklyCommits ?? null,
    sync: v.error ? { state: "error", ...v.error } : { state: "ok", fetchedAt: i?.fetchedAt ?? null },
    links: {
      self: base,
      settings: `${base}/settings`,
      issues: `${base}/issues`,
      activity: `${base}/activity`,
      nextActions: `${base}/next-actions`,
      github: i?.htmlUrl ?? `https://github.com/${v.tracked.fullName}`,
    },
  };
}

export function repoDetail(v: RepoView, now: number) {
  const i = v.insight;
  return {
    ...repoSummary(v, now),
    notes: v.tracked.notes,
    connectedAt: v.tracked.connectedAt,
    topics: i?.topics ?? [],
    stars: i?.stars ?? null,
    forks: i?.forks ?? null,
    defaultBranch: i?.defaultBranch ?? null,
    archived: i?.archived ?? null,
    latestRelease: i?.latestRelease ?? null,
    commitsSinceRelease: i?.commitsSinceRelease ?? null,
    ciRecent: i?.ci.recent ?? [],
    listsTruncated: i?.listsTruncated ?? false,
  };
}

export function actionBody(a: NextAction) {
  return {
    id: a.id,
    repo: a.repo,
    title: a.title,
    dueOn: a.dueOn,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    links: { self: `/api/v1/next-actions/${encodeURIComponent(a.id)}`, repo: repoPath(a.repo) },
  };
}
