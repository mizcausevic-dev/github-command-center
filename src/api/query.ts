import { ApiError } from "../http/problem.ts";

/** Rejects unknown query parameters so a typo (`?sotr=name`) fails loudly instead of being ignored. */
export function allowQuery(url: URL, allowed: string[]): void {
  const unknown = [...new Set([...url.searchParams.keys()])].filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new ApiError(400, "bad-request", "Unknown query parameter", `Unsupported query parameter(s): ${unknown.join(", ")}`, {
      errors: unknown.map((k) => ({ pointer: `query:${k}`, detail: `allowed: ${allowed.join(", ")}` })),
    });
  }
}

export function enumParam<T extends string>(url: URL, name: string, values: readonly T[], fallback: T): T {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if ((values as readonly string[]).includes(raw)) return raw as T;
  throw new ApiError(400, "bad-request", "Invalid query parameter", `${name} must be one of: ${values.join(", ")}`, {
    errors: [{ pointer: `query:${name}`, detail: `allowed: ${values.join(", ")}` }],
  });
}

export function listParam<T extends string>(url: URL, name: string, values: readonly T[]): T[] | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const parts = raw.split(",").map((p) => p.trim());
  const bad = parts.filter((p) => !(values as readonly string[]).includes(p));
  if (bad.length) {
    throw new ApiError(400, "bad-request", "Invalid query parameter", `${name} accepts a comma list of: ${values.join(", ")}`, {
      errors: [{ pointer: `query:${name}`, detail: `unknown value(s): ${bad.join(", ")}` }],
    });
  }
  return parts as T[];
}

export function boolParam(url: URL, name: string): boolean | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ApiError(400, "bad-request", "Invalid query parameter", `${name} must be true or false`, {
    errors: [{ pointer: `query:${name}`, detail: "expected true or false" }],
  });
}
