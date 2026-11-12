// OpenAPI 3.1 contract. A test asserts that every router route appears here
// and every operation here is routed, so the spec cannot drift from the code.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const problem = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: ref("Problem") } },
});
const jsonBody = (schema: object, description = "OK", headers?: object) => ({
  description,
  ...(headers ? { headers } : {}),
  content: { "application/json": { schema } },
});
const page = (item: string) => ({
  type: "object",
  required: ["data", "page"],
  properties: {
    data: { type: "array", items: ref(item) },
    page: ref("PageInfo"),
    total: { type: "integer", minimum: 0 },
  },
});

const H = {
  etag: { $ref: "#/components/headers/ETag" },
  link: { $ref: "#/components/headers/Link" },
  location: { $ref: "#/components/headers/Location" },
};

const common = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "406": { $ref: "#/components/responses/NotAcceptable" },
  "429": { $ref: "#/components/responses/TooManyRequests" },
};
const upstream = {
  "502": { $ref: "#/components/responses/UpstreamError" },
  "503": { $ref: "#/components/responses/UpstreamUnavailable" },
};
const notModified = { "304": { description: "Not Modified: the If-None-Match ETag still matches", headers: { ETag: H.etag } } };
const repoParams = [{ $ref: "#/components/parameters/owner" }, { $ref: "#/components/parameters/repo" }];
const pageParams = [{ $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/cursor" }];

export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "GitHub Command Center API",
      version: "1.0.0",
      summary: "Ranks which GitHub repositories need attention and tracks the owner's priorities and next actions.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: "/" }],
    security: [{}, { bearer: [] }],
    tags: [
      { name: "attention", description: "The ranked queue of repositories that need work" },
      { name: "repos", description: "Connected repositories and their GitHub state" },
      { name: "next-actions", description: "Owner-defined follow-ups per repository" },
      { name: "meta", description: "Contract, scoring model and upstream budget" },
      { name: "webhooks", description: "GitHub webhook intake for cache invalidation" },
    ],
    paths: {
      "/api/v1": {
        get: { operationId: "apiIndex", tags: ["meta"], summary: "API entry point with links", responses: { "200": jsonBody({ type: "object" }, "OK", { ETag: H.etag }), ...notModified } },
      },
      "/api/v1/openapi.json": {
        get: { operationId: "getOpenApi", tags: ["meta"], summary: "This document", responses: { "200": jsonBody({ type: "object" }), ...notModified } },
      },
      "/api/v1/attention": {
        get: {
          operationId: "getAttention",
          tags: ["attention"],
          summary: "Portfolio summary and the ranked attention queue",
          description: "Send `Cache-Control: no-cache` to revalidate every upstream GitHub resource with conditional requests.",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } }],
          responses: { "200": jsonBody(ref("AttentionReport"), "OK", { ETag: H.etag }), ...notModified, ...common, ...upstream },
        },
      },
      "/api/v1/repos": {
        get: {
          operationId: "listRepos",
          tags: ["repos"],
          summary: "List connected repositories (keyset paginated)",
          parameters: [
            { name: "sort", in: "query", schema: { type: "string", enum: ["-attention", "attention", "name", "-name", "-pushed", "pushed"], default: "-attention" } },
            { name: "band", in: "query", description: "Comma list of bands", schema: { type: "string" }, example: "critical,high" },
            { name: "q", in: "query", schema: { type: "string", maxLength: 100 } },
            { name: "pinned", in: "query", schema: { type: "boolean" } },
            ...pageParams,
          ],
          responses: { "200": jsonBody(page("RepoSummary"), "OK", { ETag: H.etag, Link: H.link }), ...notModified, ...common, ...upstream },
        },
        post: {
          operationId: "connectRepo",
          tags: ["repos"],
          summary: "Connect a repository",
          parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
          requestBody: { required: true, content: { "application/json": { schema: ref("ConnectRepo") } } },
          responses: {
            "201": jsonBody(ref("RepoSummary"), "Created", { Location: H.location }),
            "409": problem("Already connected, or the same Idempotency-Key is still in flight"),
            "415": { $ref: "#/components/responses/UnsupportedMediaType" },
            "422": problem("Validation failed, unknown repository, or Idempotency-Key reused with a different body"),
            ...common,
            ...upstream,
          },
        },
      },
      "/api/v1/repos/{owner}/{repo}": {
        parameters: repoParams,
        get: {
          operationId: "getRepo",
          tags: ["repos"],
          summary: "Repository detail with attention breakdown",
          responses: { "200": jsonBody(ref("RepoDetail"), "OK", { ETag: H.etag }), ...notModified, "404": problem("Not connected"), ...common, ...upstream },
        },
        delete: {
          operationId: "disconnectRepo",
          tags: ["repos"],
          summary: "Disconnect a repository (cascades to its next actions)",
          responses: { "204": { description: "Disconnected" }, "404": problem("Not connected"), ...common },
        },
      },
      "/api/v1/repos/{owner}/{repo}/settings": {
        parameters: repoParams,
        get: {
          operationId: "getRepoSettings",
          tags: ["repos"],
          summary: "Owner settings for a repository",
          responses: { "200": jsonBody(ref("RepoSettings"), "OK", { ETag: H.etag }), ...notModified, "404": problem("Not connected"), ...common },
        },
        patch: {
          operationId: "updateRepoSettings",
          tags: ["repos"],
          summary: "Update priority, notes or pinned (JSON Merge Patch, optimistic concurrency)",
          parameters: [{ $ref: "#/components/parameters/IfMatch" }],
          requestBody: {
            required: true,
            content: { "application/merge-patch+json": { schema: ref("RepoSettingsPatch") }, "application/json": { schema: ref("RepoSettingsPatch") } },
          },
          responses: {
            "200": jsonBody(ref("RepoSettings"), "Updated", { ETag: H.etag }),
            "404": problem("Not connected"),
            "412": problem("If-Match does not match the current ETag"),
            "415": { $ref: "#/components/responses/UnsupportedMediaType" },
            "422": problem("Validation failed"),
            "428": problem("If-Match header missing"),
            ...common,
          },
        },
      },
      "/api/v1/repos/{owner}/{repo}/issues": {
        parameters: repoParams,
        get: {
          operationId: "listRepoWorkItems",
          tags: ["repos"],
          summary: "Open issues and pull requests (keyset paginated)",
          parameters: [
            { name: "type", in: "query", schema: { type: "string", enum: ["all", "issue", "pr", "dependency"], default: "all" } },
            { name: "sort", in: "query", schema: { type: "string", enum: ["-created", "created", "-updated"], default: "-created" } },
            ...pageParams,
          ],
          responses: { "200": jsonBody(page("WorkItem"), "OK", { ETag: H.etag, Link: H.link }), ...notModified, "404": problem("Not connected"), ...common, ...upstream },
        },
      },
      "/api/v1/repos/{owner}/{repo}/activity": {
        parameters: repoParams,
        get: {
          operationId: "listRepoActivity",
          tags: ["repos"],
          summary: "Recent repository events, weekly commit counts and CI runs",
          parameters: pageParams,
          responses: { "200": jsonBody(page("ActivityEvent"), "OK", { ETag: H.etag, Link: H.link }), ...notModified, "404": problem("Not connected"), ...common, ...upstream },
        },
      },
      "/api/v1/repos/{owner}/{repo}/next-actions": {
        parameters: repoParams,
        get: {
          operationId: "listRepoNextActions",
          tags: ["next-actions"],
          summary: "Next actions for one repository",
          parameters: [{ $ref: "#/components/parameters/actionStatus" }, ...pageParams],
          responses: { "200": jsonBody(page("NextAction"), "OK", { ETag: H.etag, Link: H.link }), ...notModified, "404": problem("Not connected"), ...common },
        },
        post: {
          operationId: "createNextAction",
          tags: ["next-actions"],
          summary: "Add a next action",
          parameters: [{ $ref: "#/components/parameters/IdempotencyKey" }],
          requestBody: { required: true, content: { "application/json": { schema: ref("NextActionCreate") } } },
          responses: {
            "201": jsonBody(ref("NextAction"), "Created", { Location: H.location, ETag: H.etag }),
            "404": problem("Not connected"),
            "409": problem("Same Idempotency-Key still in flight"),
            "415": { $ref: "#/components/responses/UnsupportedMediaType" },
            "422": problem("Validation failed or Idempotency-Key reused with a different body"),
            ...common,
          },
        },
      },
      "/api/v1/next-actions": {
        get: {
          operationId: "listNextActions",
          tags: ["next-actions"],
          summary: "Next actions across the workspace, soonest due first",
          parameters: [{ $ref: "#/components/parameters/actionStatus" }, { name: "repo", in: "query", schema: { type: "string" } }, ...pageParams],
          responses: { "200": jsonBody(page("NextAction"), "OK", { ETag: H.etag, Link: H.link }), ...notModified, ...common },
        },
      },
      "/api/v1/next-actions/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9_-]{6,64}$" } }],
        get: {
          operationId: "getNextAction",
          tags: ["next-actions"],
          summary: "One next action",
          responses: { "200": jsonBody(ref("NextAction"), "OK", { ETag: H.etag }), ...notModified, "404": problem("Not found"), ...common },
        },
        patch: {
          operationId: "updateNextAction",
          tags: ["next-actions"],
          summary: "Edit or complete a next action (JSON Merge Patch, optimistic concurrency)",
          parameters: [{ $ref: "#/components/parameters/IfMatch" }],
          requestBody: {
            required: true,
            content: { "application/merge-patch+json": { schema: ref("NextActionPatch") }, "application/json": { schema: ref("NextActionPatch") } },
          },
          responses: {
            "200": jsonBody(ref("NextAction"), "Updated", { ETag: H.etag }),
            "404": problem("Not found"),
            "412": problem("If-Match does not match"),
            "415": { $ref: "#/components/responses/UnsupportedMediaType" },
            "422": problem("Validation failed"),
            "428": problem("If-Match header missing"),
            ...common,
          },
        },
        delete: {
          operationId: "deleteNextAction",
          tags: ["next-actions"],
          summary: "Delete a next action (If-Match optional)",
          responses: { "204": { description: "Deleted" }, "404": problem("Not found"), "412": problem("If-Match does not match"), ...common },
        },
      },
      "/api/v1/meta/upstream": {
        get: {
          operationId: "getUpstreamStatus",
          tags: ["meta"],
          summary: "GitHub rate-limit budget and cache effectiveness",
          responses: { "200": jsonBody(ref("UpstreamStatus"), "OK", { ETag: H.etag }), ...notModified, ...common },
        },
      },
      "/api/v1/meta/scoring": {
        get: { operationId: "getScoringModel", tags: ["meta"], summary: "Attention bands and signal weights", responses: { "200": jsonBody({ type: "object" }), ...notModified, ...common } },
      },
      "/api/v1/webhooks/github": {
        post: {
          operationId: "receiveGithubWebhook",
          tags: ["webhooks"],
          summary: "GitHub webhook receiver (HMAC-SHA256 verified, delivery de-duplicated)",
          security: [{}],
          parameters: [
            { name: "X-Hub-Signature-256", in: "header", required: true, schema: { type: "string", pattern: "^sha256=[0-9a-f]{64}$" } },
            { name: "X-GitHub-Event", in: "header", required: true, schema: { type: "string" } },
            { name: "X-GitHub-Delivery", in: "header", schema: { type: "string" } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } },
          responses: {
            "200": jsonBody({ type: "object" }, "Duplicate delivery ignored"),
            "202": jsonBody({ type: "object" }, "Accepted; cached GitHub data for the repository was invalidated"),
            "400": problem("Malformed JSON"),
            "401": problem("Signature mismatch"),
            "413": problem("Payload too large"),
            "503": problem("WEBHOOK_SECRET not configured"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Required on /api routes when the server runs with API_TOKEN set." },
      },
      parameters: {
        owner: { name: "owner", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$" } },
        repo: { name: "repo", in: "path", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9._-]{1,100}$" } },
        limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1 } },
        cursor: { name: "cursor", in: "query", description: "Opaque keyset cursor from page.nextCursor or the Link header", schema: { type: "string", maxLength: 512 } },
        actionStatus: { name: "status", in: "query", schema: { type: "string", enum: ["open", "done", "all"], default: "open" } },
        IfMatch: { name: "If-Match", in: "header", required: true, schema: { type: "string" }, description: "ETag from the latest GET of this resource" },
        IdempotencyKey: { name: "Idempotency-Key", in: "header", schema: { type: "string", minLength: 8, maxLength: 255 }, description: "Replays the first response for retries of the same request" },
      },
      headers: {
        ETag: { schema: { type: "string" }, description: "Strong validator for the representation" },
        Link: { schema: { type: "string" }, description: 'RFC 8288 links with rel="first" and rel="next"' },
        Location: { schema: { type: "string" } },
        RateLimit: { schema: { type: "string" }, description: "Remaining quota (draft-ietf-httpapi-ratelimit-headers)" },
        RetryAfter: { schema: { type: "integer" } },
      },
      responses: {
        BadRequest: problem("Malformed request, unknown query parameter or invalid cursor"),
        Unauthorized: problem("Missing or invalid bearer token"),
        NotAcceptable: problem("Accept header excludes application/json"),
        UnsupportedMediaType: problem("Wrong request Content-Type"),
        TooManyRequests: { ...problem("Rate limit exceeded"), headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } } },
        UpstreamError: problem("GitHub refused the request or returned an unexpected response"),
        UpstreamUnavailable: { ...problem("GitHub unavailable or rate limited"), headers: { "Retry-After": { $ref: "#/components/headers/RetryAfter" } } },
      },
      schemas: {
        Problem: {
          type: "object",
          required: ["type", "title", "status"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            instance: { type: "string" },
            requestId: { type: "string" },
            errors: { type: "array", items: { type: "object", required: ["pointer", "detail"], properties: { pointer: { type: "string" }, detail: { type: "string" } } } },
          },
        },
        PageInfo: { type: "object", required: ["limit", "nextCursor"], properties: { limit: { type: "integer" }, nextCursor: { type: ["string", "null"] } } },
        Priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        Band: { type: "string", enum: ["critical", "high", "watch", "healthy", "archived"] },
        Signal: {
          type: "object",
          required: ["id", "group", "points", "reason"],
          properties: {
            id: { type: "string", enum: ["ci_failing", "release_drift", "review_queue", "issue_backlog", "dependency_backlog", "dormant", "owner_priority", "action_due"] },
            group: { type: "string", enum: ["delivery", "review", "maintenance", "owner"] },
            points: { type: "integer", minimum: 1 },
            reason: { type: "string" },
          },
        },
        Attention: {
          type: ["object", "null"],
          required: ["score", "band", "signals"],
          properties: { score: { type: "integer", minimum: 0, maximum: 100 }, band: ref("Band"), signals: { type: "array", items: ref("Signal") } },
        },
        RepoSummary: {
          type: "object",
          required: ["fullName", "priority", "pinned", "attention", "sync", "links"],
          properties: {
            fullName: { type: "string" },
            priority: ref("Priority"),
            pinned: { type: "boolean" },
            description: { type: ["string", "null"] },
            language: { type: ["string", "null"] },
            htmlUrl: { type: "string", format: "uri" },
            attention: ref("Attention"),
            counts: { type: ["object", "null"] },
            ci: { type: ["object", "null"], properties: { status: { type: "string", enum: ["passing", "failing", "running", "none"] } } },
            lastCommitAt: { type: ["string", "null"], format: "date-time" },
            pushedAt: { type: ["string", "null"], format: "date-time" },
            weeklyCommits: { type: ["array", "null"], items: { type: "integer" }, minItems: 26, maxItems: 26 },
            sync: { type: "object", properties: { state: { type: "string", enum: ["ok", "error"] } } },
            links: { type: "object", additionalProperties: { type: "string" } },
          },
        },
        RepoDetail: {
          allOf: [ref("RepoSummary")],
          type: "object",
          properties: {
            notes: { type: "string" },
            topics: { type: "array", items: { type: "string" } },
            latestRelease: { type: ["object", "null"] },
            commitsSinceRelease: { type: ["integer", "null"] },
            ciRecent: { type: "array", items: { type: "object" } },
          },
        },
        ConnectRepo: {
          type: "object",
          required: ["fullName"],
          additionalProperties: false,
          properties: { fullName: { type: "string", examples: ["octocat/hello-world"] }, priority: ref("Priority"), notes: { type: "string", maxLength: 2000 }, pinned: { type: "boolean" } },
        },
        RepoSettings: {
          type: "object",
          properties: { fullName: { type: "string" }, priority: ref("Priority"), notes: { type: "string" }, pinned: { type: "boolean" }, connectedAt: { type: "string" }, updatedAt: { type: "string" } },
        },
        RepoSettingsPatch: {
          type: "object",
          additionalProperties: false,
          properties: { priority: ref("Priority"), notes: { type: ["string", "null"], maxLength: 2000 }, pinned: { type: "boolean" } },
        },
        WorkItem: {
          type: "object",
          properties: {
            number: { type: "integer" },
            kind: { type: "string", enum: ["issue", "pr"] },
            title: { type: "string" },
            author: { type: "string" },
            isBot: { type: "boolean" },
            dependency: { type: "boolean" },
            draft: { type: "boolean" },
            comments: { type: ["integer", "null"] },
            ageDays: { type: "integer" },
            htmlUrl: { type: "string", format: "uri" },
          },
        },
        ActivityEvent: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["push", "issue", "pr", "review", "release", "branch", "comment", "other"] },
            actor: { type: "string" },
            at: { type: "string", format: "date-time" },
            summary: { type: "string" },
          },
        },
        NextAction: {
          type: "object",
          properties: {
            id: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            dueOn: { type: ["string", "null"], format: "date" },
            status: { type: "string", enum: ["open", "done"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        NextActionCreate: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string", minLength: 3, maxLength: 200 }, dueOn: { type: ["string", "null"], format: "date" } },
        },
        NextActionPatch: {
          type: "object",
          additionalProperties: false,
          properties: { title: { type: "string", minLength: 3, maxLength: 200 }, dueOn: { type: ["string", "null"], format: "date" }, status: { type: "string", enum: ["open", "done"] } },
        },
        AttentionReport: {
          type: "object",
          properties: { generatedAt: { type: "string" }, summary: { type: "object" }, queue: { type: "array", items: ref("RepoSummary") } },
        },
        UpstreamStatus: { type: "object" },
      },
    },
  };
}
