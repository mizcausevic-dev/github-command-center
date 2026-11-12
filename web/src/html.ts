// Escaping template tag. Every interpolated value is HTML-escaped unless it is
// already a SafeHtml produced by this module, so GitHub-supplied strings
// (issue titles, labels, commit messages) can never inject markup.

export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (c) => ESC[c] ?? c);
}

type Value = SafeHtml | string | number | boolean | null | undefined | Value[];

function render(v: Value): string {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  return escapeHtml(String(v));
}

export function html(strings: TemplateStringsArray, ...values: Value[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? "");
  return new SafeHtml(out);
}

/** Only for markup this codebase generates itself (SVG built from numbers). */
export function trusted(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

export function mount(el: Element | null, content: SafeHtml): void {
  if (el) el.innerHTML = content.value;
}

/** Allows only http(s) links to github.com; anything else becomes "#". */
export function safeGithubUrl(url: string | null | undefined): string {
  if (!url) return "#";
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "github.com" || u.hostname.endsWith(".github.com")) ? u.toString() : "#";
  } catch {
    return "#";
  }
}
