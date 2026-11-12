# Error types

Every non-2xx response is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem document served as `application/problem+json`. Branch on `type` (stable) rather than `detail` (human text). Each document also carries `instance` (the request path) and `requestId` (echoed in the `X-Request-Id` header). Validation problems add `errors[]`, each with a JSON Pointer (`/fullName`) or a `query:<name>` / `header:<name>` marker.

```json
{
  "type": "https://github.com/mizcausevic-dev/github-command-center/blob/main/docs/errors.md#validation",
  "title": "Request failed validation",
  "status": 422,
  "detail": "2 field error(s)",
  "instance": "/api/v1/repos/acme/api/settings",
  "requestId": "3f9c1d2a7b8e4c6d9a10",
  "errors": [
    { "pointer": "/priority", "detail": "must be one of: P0, P1, P2, P3" },
    { "pointer": "/colour", "detail": "unknown field" }
  ]
}
```

## bad-request
**400.** Malformed JSON, an unknown query parameter, an out-of-range `limit`, or an invalid `Idempotency-Key`. Fix the request; retrying it unchanged will fail again.

## bad-cursor
**400.** The `cursor` was not issued by this API, or it was issued for a different query (for example a different `sort` or `band`). Restart from the first page.

## unauthorized
**401.** The server runs with `API_TOKEN` and the request lacked a matching `Authorization: Bearer` header, or a webhook's `X-Hub-Signature-256` did not match its body.

## not-found
**404.** The path does not exist, the repository is not connected to this workspace, or the next action id is unknown. Path parameters that are not a plain GitHub `owner/name` also answer 404.

## method-not-allowed
**405.** The path exists but not for this method. The `Allow` header lists the supported methods.

## not-acceptable
**406.** The `Accept` header excludes JSON. This API produces only `application/json` and `application/problem+json`.

## conflict
**409.** The repository is already connected. `Location` and the `existing` member point to it.

## precondition-failed
**412.** `If-Match` does not match the resource's current ETag: someone changed it after you read it. The response carries the current `ETag`; GET the resource, reapply your change and retry.

## precondition-required
**428.** PATCH on settings or next actions requires `If-Match`. This prevents lost updates when two tabs or clients edit the same resource.

## payload-too-large
**413.** JSON bodies are limited to 16 KiB; webhook payloads to 1 MB.

## unsupported-media-type
**415.** Wrong `Content-Type`. POST takes `application/json`; PATCH takes `application/merge-patch+json` (preferred) or `application/json`.

## validation
**422.** The body parsed but failed validation. Every failing field is listed in `errors[]` in one response. Also used when a repository to connect does not exist on GitHub or is not visible to the configured token.

## idempotency-mismatch
**422.** The `Idempotency-Key` was already used with a different request body or path. Use a new key for a new request.

## idempotency-in-flight
**409.** A request with this `Idempotency-Key` is still being processed. Retry after the `Retry-After` delay to receive the stored result.

## rate-limited
**429.** This API's own token-bucket limit was exceeded. Wait `Retry-After` seconds. `RateLimit` and `RateLimit-Policy` headers on every response show the remaining quota.

## upstream-rate-limited
**503.** GitHub's primary or secondary rate limit was reached. `Retry-After` is taken from GitHub's `retry-after` or `x-ratelimit-reset`, or set to 60 seconds when GitHub gives neither.

## upstream-unavailable
**502 / 503.** GitHub refused the request (token revoked, missing scope) or failed after retries. For a list endpoint, one failing repository is reported inline (`sync.state: "error"`) instead of failing the whole response.

## not-configured
**503.** The webhook endpoint was called but the server has no `WEBHOOK_SECRET`.

## internal
**500.** An unexpected server error. Quote the `requestId` when reporting it; details are logged server-side, not returned.
