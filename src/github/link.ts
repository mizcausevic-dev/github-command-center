// RFC 8288 Link header parser, enough for GitHub's pagination links:
//   <https://api.github.com/repositories/1/issues?page=2>; rel="next", <...>; rel="last"

export type LinkMap = Partial<Record<"next" | "prev" | "first" | "last", string>>;

export function parseLinkHeader(header: string | null): LinkMap {
  const out: LinkMap = {};
  if (!header) return out;
  for (const part of header.split(/,(?=\s*<)/)) {
    const m = /^\s*<([^>]*)>\s*((?:;\s*[^;]+)*)$/.exec(part);
    if (!m || m[1] === undefined) continue;
    const url = m[1];
    const relMatch = /;\s*rel\s*=\s*"?([^";]+)"?/i.exec(m[2] ?? "");
    if (!relMatch?.[1]) continue;
    for (const rel of relMatch[1].trim().split(/\s+/)) {
      if (rel === "next" || rel === "prev" || rel === "first" || rel === "last") out[rel] = url;
    }
  }
  return out;
}
