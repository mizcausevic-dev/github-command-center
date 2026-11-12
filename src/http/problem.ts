// RFC 9457 Problem Details. Every non-2xx response from the API uses this shape
// with Content-Type: application/problem+json, so clients branch on `type`
// (a stable URI) instead of parsing `detail` (human text that may change).

export interface FieldError {
  /** RFC 6901 JSON Pointer into the request body or a `query:<name>` marker. */
  pointer: string;
  detail: string;
}

export const PROBLEM_BASE =
  "https://github.com/mizcausevic-dev/github-command-center/blob/main/docs/errors.md#";

export type ProblemType =
  | "bad-request"
  | "bad-cursor"
  | "unauthorized"
  | "not-found"
  | "method-not-allowed"
  | "not-acceptable"
  | "conflict"
  | "precondition-failed"
  | "precondition-required"
  | "payload-too-large"
  | "unsupported-media-type"
  | "validation"
  | "idempotency-mismatch"
  | "idempotency-in-flight"
  | "rate-limited"
  | "upstream-rate-limited"
  | "upstream-unavailable"
  | "not-configured"
  | "internal";

export interface ApiErrorOptions {
  errors?: FieldError[];
  headers?: Record<string, string>;
  extensions?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: ProblemType;
  readonly title: string;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string>;
  readonly extensions: Record<string, unknown>;

  constructor(status: number, type: ProblemType, title: string, detail: string, options: ApiErrorOptions = {}) {
    super(detail);
    this.status = status;
    this.type = type;
    this.title = title;
    this.errors = options.errors;
    this.headers = options.headers ?? {};
    this.extensions = options.extensions ?? {};
  }
}

export const errors = {
  badRequest: (detail: string) => new ApiError(400, "bad-request", "Bad request", detail),
  notFound: (detail: string) => new ApiError(404, "not-found", "Resource not found", detail),
  validation: (fieldErrors: FieldError[]) =>
    new ApiError(422, "validation", "Request failed validation", `${fieldErrors.length} field error(s)`, {
      errors: fieldErrors,
    }),
  conflict: (detail: string, extensions?: Record<string, unknown>) =>
    new ApiError(409, "conflict", "Conflict with current state", detail, extensions ? { extensions } : {}),
};

export function problemResponse(err: ApiError, instance: string, requestId: string): Response {
  const body: Record<string, unknown> = {
    type: PROBLEM_BASE + err.type,
    title: err.title,
    status: err.status,
    detail: err.message,
    instance,
    requestId,
    ...err.extensions,
  };
  if (err.errors && err.errors.length > 0) body["errors"] = err.errors;
  return new Response(JSON.stringify(body), {
    status: err.status,
    headers: {
      "content-type": "application/problem+json",
      "cache-control": "no-store",
      ...err.headers,
    },
  });
}
