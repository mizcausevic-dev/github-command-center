// Allow-list sanitizers for recorded GitHub responses. The demo snapshot is
// committed to a public repository, so it keeps only the fields the app
// reads. Commit author names and e-mail addresses, issue bodies, avatars and
// node ids are dropped by construction rather than by a deny-list that could
// miss a new field.

type J = Record<string, unknown>;

const pick = (obj: unknown, keys: string[]): J => {
  const src = (obj ?? {}) as J;
  const out: J = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
};
const user = (u: unknown) => (u ? pick(u, ["login", "type"]) : null);
const labels = (ls: unknown) => (Array.isArray(ls) ? ls.map((l) => pick(l, ["name", "color"])) : []);
const firstLine = (s: unknown) => (typeof s === "string" ? s.split("\n")[0]!.slice(0, 140) : "");

function repo(r: unknown): J {
  const x = r as J;
  return {
    ...pick(x, [
      "id", "name", "full_name", "private", "html_url", "description", "fork", "language", "topics", "stargazers_count",
      "forks_count", "open_issues_count", "default_branch", "pushed_at", "created_at", "updated_at", "archived", "visibility",
    ]),
    owner: user(x["owner"]),
  };
}

function issue(i: unknown): J {
  const x = i as J;
  const out: J = {
    ...pick(x, ["id", "number", "title", "state", "html_url", "comments", "created_at", "updated_at"]),
    user: user(x["user"]),
    labels: labels(x["labels"]),
    assignees: Array.isArray(x["assignees"]) ? (x["assignees"] as unknown[]).map(user) : [],
  };
  if (x["pull_request"]) out["pull_request"] = {};
  return out;
}

function pull(p: unknown): J {
  const x = p as J;
  return {
    ...pick(x, ["id", "number", "title", "state", "html_url", "draft", "created_at", "updated_at"]),
    user: user(x["user"]),
    labels: labels(x["labels"]),
    requested_reviewers: Array.isArray(x["requested_reviewers"]) ? (x["requested_reviewers"] as unknown[]).map(user) : [],
    head: pick(x["head"], ["ref"]),
    base: pick(x["base"], ["ref"]),
  };
}

function commit(c: unknown): J {
  const x = c as J;
  const inner = (x["commit"] ?? {}) as J;
  const author = (inner["author"] ?? null) as J | null;
  return {
    sha: x["sha"],
    html_url: x["html_url"],
    commit: { author: author ? { date: author["date"] } : null, message: firstLine(inner["message"]) },
    author: user(x["author"]),
  };
}

function event(e: unknown): J {
  const x = e as J;
  const p = (x["payload"] ?? {}) as J;
  const payload: J = pick(p, ["action", "ref", "ref_type", "size", "number"]);
  if (p["issue"]) payload["issue"] = pick(p["issue"], ["number", "title"]);
  if (p["pull_request"]) payload["pull_request"] = pick(p["pull_request"], ["number", "title"]);
  if (p["release"]) payload["release"] = pick(p["release"], ["tag_name"]);
  return { id: x["id"], type: x["type"], created_at: x["created_at"], actor: user(x["actor"]), payload };
}

/** Chooses the sanitizer by endpoint path. Unknown endpoints are refused. */
export function sanitizeResponse(path: string, body: unknown): unknown {
  const p = path.replace(/^\/repositories\/\d+/, "/repos/x/x");
  const arr = (fn: (v: unknown) => J) => (Array.isArray(body) ? body.map(fn) : []);
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return repo(body);
  if (/\/issues$/.test(p)) return arr(issue);
  if (/\/pulls$/.test(p)) return arr(pull);
  if (/\/commits$/.test(p)) return arr(commit);
  if (/\/events$/.test(p)) return arr(event);
  if (/\/releases$/.test(p)) return arr((r) => pick(r, ["id", "tag_name", "name", "draft", "prerelease", "published_at", "html_url"]));
  if (/\/actions\/runs$/.test(p)) {
    const x = (body ?? {}) as J;
    const runs = Array.isArray(x["workflow_runs"]) ? (x["workflow_runs"] as unknown[]) : [];
    return {
      total_count: x["total_count"],
      workflow_runs: runs.map((r) =>
        pick(r, ["id", "name", "status", "conclusion", "created_at", "updated_at", "html_url", "event", "head_branch", "run_number"]),
      ),
    };
  }
  if (/\/compare\/[^/]+$/.test(p)) return pick(body, ["ahead_by", "behind_by", "status"]);
  throw new Error(`no sanitizer for ${path}`);
}

/** Last-line defense: fail the recording if anything that looks like an e-mail survived. */
export function findEmails(text: string): string[] {
  return [...new Set(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])];
}
