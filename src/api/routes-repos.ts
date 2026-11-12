import { etagFor, ifMatchSatisfied } from "../http/conditional.ts";
import { readJson, rules, validateObject } from "../http/body.ts";
import { ApiError, errors } from "../http/problem.ts";
import { keyComparator, linkHeader, paginate, readPageParams, type Key } from "../http/pagination.ts";
import { json, noContent } from "../http/respond.ts";
import type { Router } from "../http/router.ts";
import { sha256, base64urlEncode } from "../http/encoding.ts";
import { MAX_TRACKED_REPOS, PRIORITIES, type TrackedRepo } from "../domain/store.ts";
import { UpstreamError } from "../github/client.ts";
import { isValidFullName, repoParam, repoPath, upstreamToApi, wantsRevalidate, type Services } from "./deps.ts";
import { loadAllViews, loadView, repoDetail, repoSummary, settingsBody } from "./views.ts";
import { allowQuery, boolParam, enumParam, listParam } from "./query.ts";
import type { Band } from "../domain/attention.ts";

const SORTS = ["-attention", "attention", "name", "-name", "-pushed", "pushed"] as const;
const BAND_VALUES = ["critical", "high", "watch", "healthy", "archived"] as const;
const ITEM_TYPES = ["all", "issue", "pr", "dependency"] as const;
const ITEM_SORTS = ["-created", "created", "-updated"] as const;
const PATCH_TYPES = ["application/merge-patch+json", "application/json"];

type Summary = ReturnType<typeof repoSummary>;

function sortSpec(sort: (typeof SORTS)[number]): { key: (s: Summary) => Key; dirs: Array<1 | -1> } {
  const name = (s: Summary) => s.fullName.toLowerCase();
  const score = (s: Summary) => s.attention?.score ?? -1;
  switch (sort) {
    case "-attention":
      return { key: (s) => [score(s), name(s)], dirs: [-1, 1] };
    case "attention":
      return { key: (s) => [score(s), name(s)], dirs: [1, 1] };
    case "name":
      return { key: (s) => [name(s)], dirs: [1] };
    case "-name":
      return { key: (s) => [name(s)], dirs: [-1] };
    case "-pushed":
      return { key: (s) => [s.pushedAt ?? "", name(s)], dirs: [-1, 1] };
    case "pushed":
      return { key: (s) => [s.pushedAt ?? "", name(s)], dirs: [1, 1] };
  }
}

function requireTracked(s: Services, fullName: string): TrackedRepo {
  const t = s.store.getRepo(fullName);
  if (!t) throw errors.notFound(`${fullName} is not connected to this workspace`);
  return t;
}

export function registerRepoRoutes(router: Router, s: Services): void {
  router.add("GET", "/api/v1/repos", "listRepos", async ({ req, url }) => {
    allowQuery(url, ["sort", "band", "q", "pinned", "limit", "cursor"]);
    const sort = enumParam(url, "sort", SORTS, "-attention");
    const bands = listParam(url, "band", BAND_VALUES);
    const pinned = boolParam(url, "pinned");
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 100);
    const page = readPageParams(url, 20, 50);

    const now = s.now();
    const views = await loadAllViews(s, wantsRevalidate(req));
    let items = views.map((v) => repoSummary(v, now));
    if (bands) items = items.filter((i) => i.attention && bands.includes(i.attention.band as (typeof BAND_VALUES)[number]));
    if (pinned !== undefined) items = items.filter((i) => i.pinned === pinned);
    if (q) items = items.filter((i) => i.fullName.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q));

    const spec = sortSpec(sort);
    const result = paginate(items, spec.key, keyComparator(spec.dirs), page);
    return json(
      req,
      { data: result.items, page: { limit: page.limit, nextCursor: result.nextCursor ?? null }, total: items.length },
      { headers: { link: linkHeader(url, page.limit, result.nextCursor) } },
    );
  });

  router.add("POST", "/api/v1/repos", "connectRepo", async ({ req }) => {
    const raw = await readJson(req, ["application/json"]);
    const create = async () => {
      const body = validateObject(raw, {
        fullName: { required: true, rule: rules.string({ min: 3, max: 140, pattern: /^[^/\s]+\/[^/\s]+$/, patternHint: "must look like owner/name" }) },
        priority: { rule: rules.oneOf(PRIORITIES) },
        notes: { rule: rules.string({ max: 2000 }) },
        pinned: { rule: rules.boolean() },
      });
      const fullName = body.fullName as string;
      if (!isValidFullName(fullName)) throw errors.validation([{ pointer: "/fullName", detail: "is not a valid GitHub owner/name" }]);
      const existing = s.store.getRepo(fullName);
      if (existing) {
        throw new ApiError(409, "conflict", "Already connected", `${existing.fullName} is already connected`, {
          headers: { location: repoPath(existing.fullName) },
          extensions: { existing: repoPath(existing.fullName) },
        });
      }
      if (s.store.listRepos().length >= MAX_TRACKED_REPOS) {
        throw errors.validation([{ pointer: "/fullName", detail: `workspace limit of ${MAX_TRACKED_REPOS} repositories reached` }]);
      }
      let canonical: string;
      try {
        canonical = (await s.insights.loadRepo(fullName)).full_name;
      } catch (err) {
        if (err instanceof UpstreamError && err.kind === "not-found") {
          const hint = s.mode === "snapshot" ? " (the demo can only connect repositories in its recorded catalog)" : "";
          throw errors.validation([{ pointer: "/fullName", detail: `repository not found or not visible to the configured token${hint}` }]);
        }
        upstreamToApi(err);
      }
      // A renamed repo resolves to its new name; reject if that one is already tracked.
      if (s.store.getRepo(canonical)) throw errors.conflict(`${canonical} is already connected`);
      const at = new Date(s.now()).toISOString();
      const tracked: TrackedRepo = {
        fullName: canonical,
        priority: (body.priority as TrackedRepo["priority"] | undefined) ?? "P2",
        notes: (body.notes as string | undefined) ?? "",
        pinned: (body.pinned as boolean | undefined) ?? false,
        connectedAt: at,
        updatedAt: at,
      };
      s.store.addRepo(tracked);
      const view = await loadView(s, tracked, false);
      return json(req, repoSummary(view, s.now()), { status: 201, headers: { location: repoPath(canonical) } });
    };

    const key = req.headers.get("idempotency-key");
    if (!key) return create();
    const fingerprint = base64urlEncode(await sha256(`POST /api/v1/repos\n${JSON.stringify(raw)}`));
    return s.idempotency.run("POST /api/v1/repos", key, fingerprint, create);
  });

  router.add("GET", "/api/v1/repos/:owner/:repo", "getRepo", async ({ req, params }) => {
    const tracked = requireTracked(s, repoParam(params["owner"], params["repo"]));
    const view = await loadView(s, tracked, wantsRevalidate(req));
    return json(req, repoDetail(view, s.now()));
  });

  router.add("DELETE", "/api/v1/repos/:owner/:repo", "disconnectRepo", ({ params }) => {
    const fullName = repoParam(params["owner"], params["repo"]);
    if (!s.store.removeRepo(fullName)) throw errors.notFound(`${fullName} is not connected to this workspace`);
    return noContent();
  });

  router.add("GET", "/api/v1/repos/:owner/:repo/settings", "getRepoSettings", ({ req, params }) => {
    const tracked = requireTracked(s, repoParam(params["owner"], params["repo"]));
    return json(req, settingsBody(tracked));
  });

  router.add("PATCH", "/api/v1/repos/:owner/:repo/settings", "updateRepoSettings", async ({ req, params }) => {
    const fullName = repoParam(params["owner"], params["repo"]);
    const tracked = requireTracked(s, fullName);
    const ifMatch = req.headers.get("if-match");
    if (!ifMatch) {
      throw new ApiError(428, "precondition-required", "If-Match required", "Send If-Match with the ETag from GET .../settings to avoid overwriting a concurrent change");
    }
    const current = await etagFor(JSON.stringify(settingsBody(tracked)));
    if (!ifMatchSatisfied(ifMatch, current)) {
      throw new ApiError(412, "precondition-failed", "Settings changed", "The settings were modified since you read them; GET them again and reapply your change", {
        headers: { etag: current },
      });
    }
    const patch = validateObject(await readJson(req, PATCH_TYPES), {
      priority: { rule: rules.oneOf(PRIORITIES) },
      notes: { rule: rules.string({ max: 2000 }), nullable: true },
      pinned: { rule: rules.boolean() },
    });
    const changes: Partial<TrackedRepo> = {};
    if (patch.priority && patch.priority !== tracked.priority) changes.priority = patch.priority as TrackedRepo["priority"];
    if (patch.notes !== undefined && (patch.notes ?? "") !== tracked.notes) changes.notes = (patch.notes as string | null) ?? "";
    if (typeof patch.pinned === "boolean" && patch.pinned !== tracked.pinned) changes.pinned = patch.pinned;
    const next =
      Object.keys(changes).length === 0 ? tracked : s.store.updateRepo(fullName, { ...changes, updatedAt: new Date(s.now()).toISOString() }) ?? tracked;
    return json(req, settingsBody(next), { etag: true });
  });

  router.add("GET", "/api/v1/repos/:owner/:repo/issues", "listRepoWorkItems", async ({ req, url, params }) => {
    allowQuery(url, ["type", "sort", "limit", "cursor"]);
    const tracked = requireTracked(s, repoParam(params["owner"], params["repo"]));
    const type = enumParam(url, "type", ITEM_TYPES, "all");
    const sort = enumParam(url, "sort", ITEM_SORTS, "-created");
    const page = readPageParams(url, 25, 100);
    let insight;
    try {
      insight = await s.insights.load(tracked.fullName, wantsRevalidate(req));
    } catch (err) {
      upstreamToApi(err);
    }
    const all = [...insight.issues, ...insight.pulls];
    const items = all.filter((w) =>
      type === "all" ? true : type === "issue" ? w.kind === "issue" : type === "pr" ? w.kind === "pr" && !w.dependency : w.dependency,
    );
    const field = sort === "-updated" ? "updatedAt" : "createdAt";
    const dir: 1 | -1 = sort === "created" ? 1 : -1;
    const result = paginate(items, (w) => [w[field], w.kind, w.number], keyComparator([dir, 1, dir]), page);
    const now = s.now();
    const data = result.items.map((w) => ({ ...w, ageDays: Math.floor((now - Date.parse(w.createdAt)) / 86_400_000) }));
    return json(
      req,
      { data, page: { limit: page.limit, nextCursor: result.nextCursor ?? null }, total: items.length, truncated: insight.listsTruncated },
      { headers: { link: linkHeader(url, page.limit, result.nextCursor) } },
    );
  });

  router.add("GET", "/api/v1/repos/:owner/:repo/activity", "listRepoActivity", async ({ req, url, params }) => {
    allowQuery(url, ["limit", "cursor"]);
    const tracked = requireTracked(s, repoParam(params["owner"], params["repo"]));
    const page = readPageParams(url, 15, 50);
    let insight;
    try {
      insight = await s.insights.load(tracked.fullName, wantsRevalidate(req));
    } catch (err) {
      upstreamToApi(err);
    }
    const result = paginate(insight.events, (e) => [e.at, e.id], keyComparator([-1, -1]), page);
    return json(
      req,
      {
        data: result.items,
        page: { limit: page.limit, nextCursor: result.nextCursor ?? null },
        weeklyCommits: insight.weeklyCommits,
        ciRecent: insight.ci.recent,
      },
      { headers: { link: linkHeader(url, page.limit, result.nextCursor) } },
    );
  });
}

export type { Band };
