import { etagFor, ifMatchSatisfied } from "../http/conditional.ts";
import { readJson, rules, validateObject } from "../http/body.ts";
import { ApiError, errors } from "../http/problem.ts";
import { keyComparator, linkHeader, paginate, readPageParams } from "../http/pagination.ts";
import { json, noContent } from "../http/respond.ts";
import type { Router } from "../http/router.ts";
import { base64urlEncode, sha256 } from "../http/encoding.ts";
import { ACTION_STATUSES, MAX_ACTIONS_PER_REPO, type NextAction } from "../domain/store.ts";
import { repoParam, type Services } from "./deps.ts";
import { actionBody } from "./views.ts";
import { allowQuery, enumParam } from "./query.ts";

const STATUS_FILTER = ["open", "done", "all"] as const;
const ID = /^[A-Za-z0-9_-]{6,64}$/;

function requireAction(s: Services, id: string | undefined): NextAction {
  const action = id && ID.test(id) ? s.store.getAction(id) : undefined;
  if (!action) throw errors.notFound("No next action with that id");
  return action;
}

async function checkIfMatch(req: Request, action: NextAction, required: boolean): Promise<void> {
  const ifMatch = req.headers.get("if-match");
  if (!ifMatch) {
    if (!required) return;
    throw new ApiError(428, "precondition-required", "If-Match required", "Send If-Match with the ETag from GET /api/v1/next-actions/{id}");
  }
  const current = await etagFor(JSON.stringify(actionBody(action)));
  if (!ifMatchSatisfied(ifMatch, current)) {
    throw new ApiError(412, "precondition-failed", "Next action changed", "The next action was modified since you read it", { headers: { etag: current } });
  }
}

// Due dates sort before "no due date"; ties break on creation time then id.
const dueKey = (a: NextAction) => [a.dueOn ?? "9999-12-31", a.createdAt, a.id];

export function registerActionRoutes(router: Router, s: Services): void {
  const list = (req: Request, url: URL, repo?: string) => {
    allowQuery(url, ["status", "limit", "cursor", ...(repo ? [] : ["repo"])]);
    const status = enumParam(url, "status", STATUS_FILTER, "open");
    const repoFilter = repo ?? url.searchParams.get("repo") ?? undefined;
    const page = readPageParams(url, 25, 100);
    const items = s.store.listActions(repoFilter).filter((a) => status === "all" || a.status === status);
    const result = paginate(items, dueKey, keyComparator([1, 1, 1]), page);
    return json(
      req,
      { data: result.items.map(actionBody), page: { limit: page.limit, nextCursor: result.nextCursor ?? null }, total: items.length },
      { headers: { link: linkHeader(url, page.limit, result.nextCursor) } },
    );
  };

  router.add("GET", "/api/v1/next-actions", "listNextActions", ({ req, url }) => list(req, url));

  router.add("GET", "/api/v1/repos/:owner/:repo/next-actions", "listRepoNextActions", ({ req, url, params }) => {
    const fullName = repoParam(params["owner"], params["repo"]);
    const tracked = s.store.getRepo(fullName);
    if (!tracked) throw errors.notFound(`${fullName} is not connected to this workspace`);
    return list(req, url, tracked.fullName);
  });

  router.add("POST", "/api/v1/repos/:owner/:repo/next-actions", "createNextAction", async ({ req, params }) => {
    const fullName = repoParam(params["owner"], params["repo"]);
    const tracked = s.store.getRepo(fullName);
    if (!tracked) throw errors.notFound(`${fullName} is not connected to this workspace`);
    const raw = await readJson(req, ["application/json"]);
    const create = async () => {
      const body = validateObject(raw, {
        title: { required: true, rule: rules.string({ min: 3, max: 200 }) },
        dueOn: { rule: rules.date(), nullable: true },
      });
      if (s.store.listActions(tracked.fullName).filter((a) => a.status === "open").length >= MAX_ACTIONS_PER_REPO) {
        throw errors.validation([{ pointer: "", detail: `limit of ${MAX_ACTIONS_PER_REPO} open next actions per repository reached` }]);
      }
      const at = new Date(s.now()).toISOString();
      const action: NextAction = {
        id: s.newId(),
        repo: tracked.fullName,
        title: body.title as string,
        dueOn: (body.dueOn as string | null | undefined) ?? null,
        status: "open",
        createdAt: at,
        updatedAt: at,
      };
      s.store.addAction(action);
      return json(req, actionBody(action), { status: 201, etag: true, headers: { location: actionBody(action).links.self } });
    };
    const key = req.headers.get("idempotency-key");
    if (!key) return create();
    const fingerprint = base64urlEncode(await sha256(`POST ${tracked.fullName}/next-actions\n${JSON.stringify(raw)}`));
    return s.idempotency.run(`POST /next-actions ${tracked.fullName.toLowerCase()}`, key, fingerprint, create);
  });

  router.add("GET", "/api/v1/next-actions/:id", "getNextAction", ({ req, params }) => json(req, actionBody(requireAction(s, params["id"]))));

  router.add("PATCH", "/api/v1/next-actions/:id", "updateNextAction", async ({ req, params }) => {
    const action = requireAction(s, params["id"]);
    await checkIfMatch(req, action, true);
    const patch = validateObject(await readJson(req, ["application/merge-patch+json", "application/json"]), {
      title: { rule: rules.string({ min: 3, max: 200 }) },
      dueOn: { rule: rules.date(), nullable: true },
      status: { rule: rules.oneOf(ACTION_STATUSES) },
    });
    const changes: Partial<NextAction> = {};
    if (patch.title !== undefined && patch.title !== action.title) changes.title = patch.title as string;
    if (patch.dueOn !== undefined && patch.dueOn !== action.dueOn) changes.dueOn = patch.dueOn as string | null;
    if (patch.status !== undefined && patch.status !== action.status) changes.status = patch.status as NextAction["status"];
    const next = Object.keys(changes).length
      ? (s.store.updateAction(action.id, { ...changes, updatedAt: new Date(s.now()).toISOString() }) ?? action)
      : action;
    return json(req, actionBody(next), { etag: true });
  });

  router.add("DELETE", "/api/v1/next-actions/:id", "deleteNextAction", async ({ req, params }) => {
    const action = requireAction(s, params["id"]);
    await checkIfMatch(req, action, false);
    s.store.removeAction(action.id);
    return noContent();
  });
}
