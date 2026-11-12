// RFC 8288 Link header parser, enough for GitHub's pagination links:
//   <https://api.github.com/repositories/1/issues?page=2>; rel="next", <...>; rel="last"

export type LinkMap = Partial<Record<"next" | "prev" | "first" | "last", string>>;

export function parseLinkHeader(header: string | null): LinkMap {
  const out: LinkMap = {};
  if (!header) return out;
  for (const part of header.split(/,(?=\s*<)/)) {
    // Linear time: split the URL from its params, then split params on ";" (no nested quantifiers).
    const m = /^\s*<([^>]*)>(.*)$/.exec(part);
    if (!m || m[1] === undefined) continue;
    const url = m[1];
    const relParam = (m[2] ?? "").split(";").map((x) => x.trim()).find((x) => /^rel\s*=/i.test(x));
    const relValue = relParam?.replace(/^rel\s*=\s*/i, "").replace(/^"|"$/g, "");
    if (!relValue) continue;
    for (const rel of relValue.trim().split(/\s+/)) {
      if (rel === "next" || rel === "prev" || rel === "first" || rel === "last") out[rel] = url;
    }
  }
  return out;
}
