// The subset of GitHub REST response fields this project reads. The snapshot
// recorder keeps exactly these fields (see sanitize.ts); anything not listed
// here, such as commit author e-mail addresses, never reaches the demo data.

export interface GhUserRef {
  login: string;
  type?: string;
}

export interface GhLabel {
  name: string;
  color: string;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  language: string | null;
  topics?: string[];
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  default_branch: string;
  pushed_at: string | null;
  created_at: string;
  updated_at: string;
  archived: boolean;
  visibility?: string;
  owner: GhUserRef;
}

export interface GhIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  comments: number;
  created_at: string;
  updated_at: string;
  user: GhUserRef | null;
  labels: GhLabel[];
  assignees?: GhUserRef[];
  /** Present (as an object) when the issue is a pull request. */
  pull_request?: Record<string, never>;
}

export interface GhPull {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  draft?: boolean;
  created_at: string;
  updated_at: string;
  user: GhUserRef | null;
  labels: GhLabel[];
  requested_reviewers?: GhUserRef[];
  head?: { ref: string };
  base?: { ref: string };
}

export interface GhWorkflowRun {
  id: number;
  name: string | null;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  event: string;
  head_branch: string | null;
  run_number: number;
}

export interface GhRunsPage {
  total_count: number;
  workflow_runs: GhWorkflowRun[];
}

export interface GhRelease {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  html_url: string;
}

export interface GhCompare {
  ahead_by: number;
  behind_by: number;
  status: string;
}

export interface GhCommit {
  sha: string;
  html_url: string;
  commit: { author: { date: string } | null; message: string };
  author: GhUserRef | null;
}

export interface GhEvent {
  id: string;
  type: string;
  created_at: string;
  actor: GhUserRef;
  payload: {
    action?: string;
    ref?: string | null;
    ref_type?: string;
    size?: number;
    number?: number;
    issue?: { number: number; title: string };
    pull_request?: { number: number; title?: string };
    release?: { tag_name: string };
  };
}
