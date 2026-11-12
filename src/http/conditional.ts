// Entity tags and conditional requests (RFC 9110 §8.8.3, §13).
//
// ETags here are strong validators derived from the exact JSON bytes of a
// representation, so two byte-identical bodies always share a tag and any
// change to a field changes the tag. That one rule backs both directions:
//   - If-None-Match (reads): weak comparison, a hit returns 304 with no body.
//   - If-Match (writes): strong comparison, a miss returns 412 so a client
//     cannot silently overwrite a change it never saw (lost-update problem).

import { base64urlEncode, sha256 } from "./encoding.ts";

export async function etagFor(body: string): Promise<string> {
  const digest = await sha256(body);
  return `"${base64urlEncode(digest).slice(0, 27)}"`;
}

/** Splits an entity-tag list, keeping quoted tags intact (tags may contain commas). */
export function parseEtagList(header: string): string[] {
  const out: string[] = [];
  const re = /\s*(\*|(?:W\/)?"[^"]*")\s*(?:,|$)/gy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    if (m[1]) out.push(m[1]);
    if (re.lastIndex >= header.length) break;
  }
  return out;
}

const opaque = (tag: string) => (tag.startsWith("W/") ? tag.slice(2) : tag);

/** If-None-Match uses the weak comparison function. */
export function ifNoneMatchHits(header: string | null, current: string): boolean {
  if (!header) return false;
  const tags = parseEtagList(header);
  return tags.some((t) => t === "*" || opaque(t) === opaque(current));
}

/** If-Match uses the strong comparison function: weak tags never match. */
export function ifMatchSatisfied(header: string, current: string): boolean {
  const tags = parseEtagList(header);
  return tags.some((t) => t === "*" || (!t.startsWith("W/") && !current.startsWith("W/") && t === current));
}
