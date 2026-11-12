// Aggregates one repository's state from seven GitHub REST endpoints into a
// single RepoInsight. Independent reads run concurrently; only the release
// comparison depends on an earlier result.

import { UpstreamError, type GitHubClient } from "../github/client.ts";
import type { GhCommit, GhCompare, GhEvent, GhIssue, GhPull, GhRelease, GhRepo, GhRunsPage } from "../github/types.ts";

const DAY = 86_400_000;
export const ACTIVITY_WEEKS = 26;

export interface LabelSummary {
  name: string;
  color: string;
}

export interface WorkItem {
  number: number;
  kind: "issue" | "pr";
  title: string;
  author: string;
  isBot: boolean;
  dependency: boolean;
  draft: boolean;
  labels: LabelSummary[];
  comments: number | null;
  reviewers: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export type CiStatus = "passing" | "failing" | "running" | "none";

export interface CiSummary {
  status: CiStatus;
  failingWorkflows: string[];
  lastRunAt: string | null;
  url: string | null;
  recent: Array<{ workflow: string; conclusion: string | null; status: string | null; at: string; url: string }>;
}

export type ActivityKind = "push" | "issue" | "pr" | "review" | "release" | "branch" | "comment" | "other";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  actor: string;
  at: string;
  summary: string;
}

export interface RepoInsight {
  fullName: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  forks: number;
  defaultBranch: string;
  archived: boolean;
  isPrivate: boolean;
  pushedAt: string | null;
  issues: WorkItem[];
  pulls: WorkItem[];
  listsTruncated: boolean;
  ci: CiSummary;
  latestRelease: { tag: string; publishedAt: string | null; url: string } | null;
  commitsSinceRelease: number | null;
  weeklyCommits: number[];
  lastCommitAt: string | null;
  events: ActivityEvent[];
  fetchedAt: string;
}

export function isBotLogin(user: { login: string; type?: string } | null): boolean {
  if (!user) return false;
  return user.type === "Bot" || user.login.endsWith("[bot]");
}

const DEPENDENCY_BOTS = new Set(["dependabot[bot]", "renovate[bot]"]);

/** Start of the UTC day `days` before `now`, so the `since` query string is stable for a whole day. */
export function activitySince(now: number): string {
  const d = new Date(now - ACTIVITY_WEEKS * 7 * DAY);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function optional<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    // Repos with Actions disabled, no commits (409) or no events answer with
    // 404/403/409; treat those as "no data", but let auth and rate-limit errors surface.
    if (err instanceof UpstreamError && (err.kind === "not-found" || err.kind === "forbidden" || err.status === 409)) return fallback;
    throw err;
  }
}

export class InsightService {
  private readonly github: GitHubClient;
  private readonly now: () => number;

  constructor(github: GitHubClient, now: () => number) {
    this.github = github;
    this.now = now;
  }

  async loadRepo(fullName: string, revalidate = false): Promise<GhRepo> {
    return (await this.github.get<GhRepo>(`/repos/${fullName}`, { revalidate })).data;
  }

  async load(fullName: string, revalidate = false): Promise<RepoInsight> {
    const repo = await this.loadRepo(fullName, revalidate);
    const fn = repo.full_name;
    const o = { revalidate };
    const now = this.now();

    const [issues, pulls, runs, releases, commits, events] = await Promise.all([
      this.github.paginate<GhIssue>(`/repos/${fn}/issues`, { ...o, query: { state: "open", per_page: 50 }, maxPages: 3 }),
      this.github.paginate<GhPull>(`/repos/${fn}/pulls`, { ...o, query: { state: "open", per_page: 50 }, maxPages: 3 }),
      optional(
        this.github
          .get<GhRunsPage>(`/repos/${fn}/actions/runs`, {
            ...o,
            query: { branch: repo.default_branch, per_page: 40, exclude_pull_requests: true },
          })
          .then((r) => r.data),
        { total_count: 0, workflow_runs: [] },
      ),
      optional(this.github.get<GhRelease[]>(`/repos/${fn}/releases`, { ...o, query: { per_page: 5 } }).then((r) => r.data), []),
      optional(
        this.github
          .paginate<GhCommit>(`/repos/${fn}/commits`, {
            ...o,
            query: { sha: repo.default_branch, since: activitySince(now), per_page: 100 },
            maxPages: 3,
          })
          .then((r) => r.items),
        [],
      ),
      optional(this.github.get<GhEvent[]>(`/repos/${fn}/events`, { ...o, query: { per_page: 30 } }).then((r) => r.data), []),
    ]);

    const release = releases.find((r) => !r.draft && !r.prerelease) ?? null;
    let commitsSinceRelease: number | null = null;
    if (release) {
      const base = encodeURIComponent(release.tag_name);
      const head = encodeURIComponent(repo.default_branch);
      const cmp = await optional(
        this.github.get<GhCompare>(`/repos/${fn}/compare/${base}...${head}`, { ...o, query: { per_page: 1 } }).then((r) => r.data),
        null,
      );
      commitsSinceRelease = cmp ? cmp.ahead_by : null;
    }

    return {
      fullName: fn,
      htmlUrl: repo.html_url,
      description: repo.description,
      language: repo.language,
      topics: repo.topics ?? [],
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      defaultBranch: repo.default_branch,
      archived: repo.archived,
      isPrivate: repo.private,
      pushedAt: repo.pushed_at,
      issues: issues.items.filter((i) => !i.pull_request).map(issueItem),
      pulls: pulls.items.map(pullItem),
      listsTruncated: issues.truncated || pulls.truncated,
      ci: summarizeRuns(runs),
      latestRelease: release ? { tag: release.tag_name, publishedAt: release.published_at, url: release.html_url } : null,
      commitsSinceRelease,
      weeklyCommits: weeklyBuckets(commits, now),
      lastCommitAt: commits[0]?.commit.author?.date ?? null,
      events: events.map(summarizeEvent),
      fetchedAt: new Date(now).toISOString(),
    };
  }
}

function issueItem(i: GhIssue): WorkItem {
  return {
    number: i.number,
    kind: "issue",
    title: i.title,
    author: i.user?.login ?? "ghost",
    isBot: isBotLogin(i.user),
    dependency: false,
    draft: false,
    labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: i.comments,
    reviewers: [],
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    htmlUrl: i.html_url,
  };
}

function pullItem(p: GhPull): WorkItem {
  const login = p.user?.login ?? "ghost";
  return {
    number: p.number,
    kind: "pr",
    title: p.title,
    author: login,
    isBot: isBotLogin(p.user),
    dependency: DEPENDENCY_BOTS.has(login) || p.labels.some((l) => l.name === "dependencies"),
    draft: Boolean(p.draft),
    labels: p.labels.map((l) => ({ name: l.name, color: l.color })),
    comments: null,
    reviewers: (p.requested_reviewers ?? []).map((r) => r.login),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    htmlUrl: p.html_url,
  };
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export function summarizeRuns(page: GhRunsPage): CiSummary {
  // Dependabot version-update jobs run with event "dynamic"; they are automation,
  // not the repository's CI, so they must not decide whether main is green.
  const runs = page.workflow_runs.filter((r) => r.event !== "dynamic").sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latestByWorkflow = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const name = r.name ?? "workflow";
    if (r.status === "completed" && !latestByWorkflow.has(name)) latestByWorkflow.set(name, r);
  }
  const failing = [...latestByWorkflow.entries()].filter(([, r]) => FAILED.has(r.conclusion ?? "")).map(([n]) => n);
  const anyRunning = runs.some((r) => r.status !== "completed");
  let status: CiStatus = "none";
  if (failing.length > 0) status = "failing";
  else if (latestByWorkflow.size > 0) status = "passing";
  else if (anyRunning) status = "running";
  const newest = runs[0];
  return {
    status,
    failingWorkflows: failing.sort(),
    lastRunAt: newest?.created_at ?? null,
    url: failing.length > 0 ? (latestByWorkflow.get(failing[0] ?? "")?.html_url ?? null) : (newest?.html_url ?? null),
    recent: runs.slice(0, 10).map((r) => ({
      workflow: r.name ?? "workflow",
      conclusion: r.conclusion,
      status: r.status,
      at: r.created_at,
      url: r.html_url,
    })),
  };
}

export function weeklyBuckets(commits: GhCommit[], now: number): number[] {
  const buckets = new Array<number>(ACTIVITY_WEEKS).fill(0);
  for (const c of commits) {
    const date = c.commit.author?.date;
    if (!date) continue;
    const age = Math.floor((now - Date.parse(date)) / (7 * DAY));
    if (age >= 0 && age < ACTIVITY_WEEKS) buckets[ACTIVITY_WEEKS - 1 - age]! += 1;
  }
  return buckets;
}

export function summarizeEvent(e: GhEvent): ActivityEvent {
  const p = e.payload ?? {};
  const branch = (p.ref ?? "").replace(/^refs\/heads\//, "");
  const num = p.issue?.number ?? p.pull_request?.number ?? p.number;
  let kind: ActivityKind = "other";
  let summary = e.type.replace(/Event$/, "");
  switch (e.type) {
    case "PushEvent":
      kind = "push";
      summary = p.size ? `pushed ${p.size} commit${p.size === 1 ? "" : "s"} to ${branch}` : `pushed to ${branch || "a branch"}`;
      break;
    case "IssuesEvent":
      kind = "issue";
      summary = `${p.action ?? "updated"} issue #${num}${p.issue?.title ? `: ${p.issue.title}` : ""}`;
      break;
    case "PullRequestEvent":
      kind = "pr";
      summary = `${p.action ?? "updated"} pull request #${num}${p.pull_request?.title ? `: ${p.pull_request.title}` : ""}`;
      break;
    case "PullRequestReviewEvent":
      kind = "review";
      summary = `reviewed pull request #${num}`;
      break;
    case "IssueCommentEvent":
      kind = "comment";
      summary = `commented on #${num}`;
      break;
    case "ReleaseEvent":
      kind = "release";
      summary = `${p.action ?? "published"} release ${p.release?.tag_name ?? ""}`.trim();
      break;
    case "CreateEvent":
      kind = "branch";
      summary = `created ${p.ref_type ?? "ref"}${p.ref ? ` ${p.ref}` : ""}`;
      break;
    case "DeleteEvent":
      kind = "branch";
      summary = `deleted ${p.ref_type ?? "ref"}${p.ref ? ` ${p.ref}` : ""}`;
      break;
    case "WatchEvent":
      summary = "starred the repository";
      break;
    case "ForkEvent":
      summary = "forked the repository";
      break;
  }
  return { id: e.id, kind, actor: e.actor.login, at: e.created_at, summary };
}
