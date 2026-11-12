// Request body intake and a small declarative validator.
//
// The validator collects every field error before failing so a client gets
// one 422 listing all problems (each with a JSON Pointer), not one error per
// round trip. Unknown fields are rejected: silently ignoring a misspelled
// `priorty` would report success while changing nothing.

import { ApiError, errors, type FieldError } from "./problem.ts";

export const MAX_BODY_BYTES = 16 * 1024;

export async function readJson(req: Request, accepted: string[]): Promise<unknown> {
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!accepted.includes(contentType)) {
    throw new ApiError(415, "unsupported-media-type", "Unsupported media type", `Send the body as ${accepted.join(" or ")}`, {
      headers: { "accept-patch": accepted.join(", "), accept: accepted.join(", ") },
    });
  }
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw tooLarge();
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw tooLarge();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "bad-request", "Malformed JSON", "The request body is not valid JSON");
  }
}

function tooLarge(): ApiError {
  return new ApiError(413, "payload-too-large", "Payload too large", `Request bodies are limited to ${MAX_BODY_BYTES} bytes`);
}

type Rule<T> = (value: unknown, pointer: string, errs: FieldError[]) => T | undefined;

export interface FieldSpec<T> {
  rule: Rule<T>;
  required?: boolean;
  /** Allow explicit null (used by JSON Merge Patch to clear a field). */
  nullable?: boolean;
}

export type Shape = Record<string, FieldSpec<unknown>>;
export type Parsed<S extends Shape> = { [K in keyof S]?: S[K] extends FieldSpec<infer T> ? T | null : never };

export function validateObject<S extends Shape>(input: unknown, shape: S): Parsed<S> {
  const errs: FieldError[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw errors.validation([{ pointer: "", detail: "body must be a JSON object" }]);
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!(key in shape)) errs.push({ pointer: `/${escapePointer(key)}`, detail: "unknown field" });
  }
  for (const [key, spec] of Object.entries(shape)) {
    const pointer = `/${escapePointer(key)}`;
    if (!(key in obj)) {
      if (spec.required) errs.push({ pointer, detail: "is required" });
      continue;
    }
    const value = obj[key];
    if (value === null) {
      if (spec.nullable) out[key] = null;
      else errs.push({ pointer, detail: "must not be null" });
      continue;
    }
    const parsed = spec.rule(value, pointer, errs);
    if (parsed !== undefined) out[key] = parsed;
  }
  if (errs.length > 0) throw errors.validation(errs);
  return out as Parsed<S>;
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

export const rules = {
  string(opts: { min?: number; max: number; pattern?: RegExp; patternHint?: string; trim?: boolean }): Rule<string> {
    return (value, pointer, errs) => {
      if (typeof value !== "string") {
        errs.push({ pointer, detail: "must be a string" });
        return undefined;
      }
      const v = opts.trim === false ? value : value.trim();
      if (v.length < (opts.min ?? 0)) errs.push({ pointer, detail: `must be at least ${opts.min} characters` });
      else if (v.length > opts.max) errs.push({ pointer, detail: `must be at most ${opts.max} characters` });
      else if (opts.pattern && !opts.pattern.test(v)) errs.push({ pointer, detail: opts.patternHint ?? "has an invalid format" });
      else return v;
      return undefined;
    };
  },
  oneOf<T extends string>(values: readonly T[]): Rule<T> {
    return (value, pointer, errs) => {
      if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
      errs.push({ pointer, detail: `must be one of: ${values.join(", ")}` });
      return undefined;
    };
  },
  boolean(): Rule<boolean> {
    return (value, pointer, errs) => {
      if (typeof value === "boolean") return value;
      errs.push({ pointer, detail: "must be a boolean" });
      return undefined;
    };
  },
  /** Calendar date YYYY-MM-DD that actually exists (rejects 2026-02-30). */
  date(): Rule<string> {
    return (value, pointer, errs) => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const d = new Date(`${value}T00:00:00Z`);
        if (!Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value) return value;
      }
      errs.push({ pointer, detail: "must be a calendar date in YYYY-MM-DD form" });
      return undefined;
    };
  },
};
