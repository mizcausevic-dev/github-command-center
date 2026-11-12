// Hand-built SVG charts (no chart library). Colors come from CSS classes
// (s1-s4 series, q0-q5 sequential, st-* status) so a theme or mode switch
// restyles them without re-rendering, and no inline style attributes are
// needed under the strict CSP. Each mark carries a `data-tip` for the hover
// tooltip; every chart also has a table view or text alternative.

import { escapeHtml, trusted, type SafeHtml } from "./html.ts";

const esc = escapeHtml;
const r1 = (n: number) => Math.round(n * 10) / 10;

export type Band = "critical" | "high" | "watch" | "healthy" | "archived";
export const GROUPS = [
  { id: "delivery", label: "Delivery (CI, release drift)", cls: "s1" },
  { id: "review", label: "Review & issues", cls: "s2" },
  { id: "maintenance", label: "Maintenance (deps, dormancy)", cls: "s3" },
  { id: "owner", label: "Owner (priority, due actions)", cls: "s4" },
] as const;
export type GroupId = (typeof GROUPS)[number]["id"];

const BAND_LABEL: Record<Band, string> = { critical: "Critical", high: "High", watch: "Watch", healthy: "Healthy", archived: "Archived" };

/** Status icon + label so band is never conveyed by color alone. */
export function bandBadge(band: Band): SafeHtml {
  const icons: Record<Band, string> = {
    critical: '<path d="M6 1 11 10H1z" class="st-critical"/><rect x="5.4" y="4" width="1.2" height="3.2" fill="#fff"/><rect x="5.4" y="7.8" width="1.2" height="1.2" fill="#fff"/>',
    high: '<path d="M6 1 11 6 6 11 1 6z" class="st-high"/>',
    watch: '<circle cx="6" cy="6" r="5" class="st-watch"/>',
    healthy: '<circle cx="6" cy="6" r="5" class="st-healthy"/><path d="M3.5 6.2 5.2 7.8 8.6 4.4" stroke="#fff" stroke-width="1.4" fill="none"/>',
    archived: '<rect x="1" y="1" width="10" height="10" rx="2" class="st-muted"/>',
  };
  return trusted(`<span class="band"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${icons[band]}</svg>${BAND_LABEL[band]}</span>`);
}

export function scoreRing(score: number, band: Band): SafeHtml {
  const r = 24;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  return trusted(
    `<svg width="60" height="60" viewBox="0 0 60 60" role="img" aria-label="Attention score ${score} of 100, ${BAND_LABEL[band]}">` +
      `<circle cx="30" cy="30" r="${r}" fill="none" stroke-width="6" class="ring-track"/>` +
      `<circle cx="30" cy="30" r="${r}" fill="none" stroke-width="6" stroke-linecap="round" class="ring-${band}" stroke-dasharray="${r1(filled)} ${r1(c)}" transform="rotate(-90 30 30)"/>` +
      `<text x="30" y="35" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">${score}</text></svg>`,
  );
}

export function sparkline(values: number[], label: string): SafeHtml {
  const w = 120;
  const h = 30;
  const max = Math.max(1, ...values);
  const step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [r1(i * step), r1(h - 2 - (v / max) * (h - 6))] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  const total = values.reduce((a, b) => a + b, 0);
  return trusted(
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}: ${total} commits in ${values.length} weeks">` +
      `<path d="${area}" class="spark-area"/><path d="${line}" class="spark-line"/></svg>`,
  );
}

export interface BreakdownRow {
  name: string;
  score: number;
  band: Band;
  groups: Record<GroupId, number>;
  reasons: string[];
}

export function breakdownChart(rows: BreakdownRow[]): SafeHtml {
  const labelW = 178;
  const plotW = 340;
  const rowH = 26;
  const top = 18;
  const w = labelW + plotW + 46;
  const h = top + rows.length * rowH + 8;
  const max = Math.max(100, ...rows.map((r) => GROUPS.reduce((s, g) => s + r.groups[g.id], 0)));
  const x = (v: number) => (v / max) * plotW;
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Attention score breakdown for the top ${rows.length} repositories">`;
  for (const tick of [0, 25, 50, 75, 100]) {
    const tx = r1(labelW + x(tick));
    svg += `<line x1="${tx}" x2="${tx}" y1="${top - 6}" y2="${h - 6}" class="grid-line"/><text x="${tx}" y="10" text-anchor="middle" class="axis-label">${tick}</text>`;
  }
  rows.forEach((row, i) => {
    const y = top + i * rowH;
    const short = row.name.split("/")[1] ?? row.name;
    svg += `<text x="${labelW - 8}" y="${y + 16}" text-anchor="end">${esc(short.length > 26 ? short.slice(0, 25) + "…" : short)}</text>`;
    let cursor = labelW;
    for (const g of GROUPS) {
      const v = row.groups[g.id];
      if (v <= 0) continue;
      const bw = x(v);
      const tip = `${row.name}\n${g.label}: ${v} pts`;
      svg += `<rect x="${r1(cursor)}" y="${y + 4}" width="${r1(Math.max(1, bw))}" height="${rowH - 9}" rx="3" class="${g.cls} mark" data-tip="${esc(tip)}"/>`;
      cursor += bw;
    }
    svg += `<text x="${r1(cursor + 6)}" y="${y + 16}" class="value-label">${row.score}</text>`;
  });
  svg += `<line x1="${labelW}" x2="${labelW}" y1="${top - 6}" y2="${h - 6}" class="baseline"/></svg>`;
  return trusted(svg);
}

export function breakdownTable(rows: BreakdownRow[]): SafeHtml {
  const head = `<tr><th>Repository</th>${GROUPS.map((g) => `<th class="num">${esc(g.label.split(" (")[0] ?? g.label)}</th>`).join("")}<th class="num">Score</th></tr>`;
  const body = rows
    .map((r) => `<tr><td>${esc(r.name)}</td>${GROUPS.map((g) => `<td class="num">${r.groups[g.id]}</td>`).join("")}<td class="num">${r.score}</td></tr>`)
    .join("");
  return trusted(`<table class="data"><thead>${head}</thead><tbody>${body}</tbody></table>`);
}

export interface CiCounts {
  failing: number;
  passing: number;
  running: number;
  none: number;
}

export function ciDonut(c: CiCounts): SafeHtml {
  const parts = [
    { key: "failing", label: "Failing", cls: "st-critical", v: c.failing },
    { key: "running", label: "Running", cls: "st-watch", v: c.running },
    { key: "passing", label: "Passing", cls: "st-healthy", v: c.passing },
    { key: "none", label: "No workflows", cls: "st-muted", v: c.none },
  ];
  const total = parts.reduce((s, p) => s + p.v, 0) || 1;
  const R = 52;
  const r = 34;
  let a0 = -Math.PI / 2;
  let svg = `<svg viewBox="0 0 132 132" role="img" aria-label="CI on default branch: ${c.failing} failing, ${c.passing} passing, ${c.running} running, ${c.none} without workflows">`;
  for (const p of parts) {
    if (p.v === 0) continue;
    const a1 = a0 + (p.v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rad: number, a: number) => `${r1(66 + rad * Math.cos(a))} ${r1(66 + rad * Math.sin(a))}`;
    const d =
      p.v === total
        ? `M66 ${66 - R} A${R} ${R} 0 1 1 65.99 ${66 - R} L65.99 ${66 - r} A${r} ${r} 0 1 0 66 ${66 - r} Z`
        : `M${pt(R, a0)} A${R} ${R} 0 ${large} 1 ${pt(R, a1)} L${pt(r, a1)} A${r} ${r} 0 ${large} 0 ${pt(r, a0)} Z`;
    svg += `<path d="${d}" class="${p.cls} mark" data-tip="${esc(`${p.label}: ${p.v} repo${p.v === 1 ? "" : "s"}`)}"/>`;
    a0 = a1;
  }
  svg += `<text x="66" y="66" text-anchor="middle" font-size="26" font-weight="700" fill="currentColor">${c.failing}</text><text x="66" y="84" text-anchor="middle" class="axis-label">failing</text></svg>`;
  const legend = parts
    .map((p) => `<li><span class="swatch ${p.cls}"></span>${p.label} <b>${p.v}</b></li>`)
    .join("");
  return trusted(`<div class="chart donut">${svg}</div><ul class="legend">${legend}</ul>`);
}

export interface AgingBucket {
  label: string;
  issues: number;
  prs: number;
  deps: number;
}

const AGING_SERIES = [
  { key: "issues", label: "Issues", cls: "s1" },
  { key: "prs", label: "Pull requests", cls: "s2" },
  { key: "deps", label: "Dependency updates", cls: "s3" },
] as const;

export function agingChart(buckets: AgingBucket[]): SafeHtml {
  const w = 360;
  const h = 190;
  const left = 30;
  const bottom = 24;
  const plotH = h - bottom - 16;
  const max = Math.max(1, ...buckets.map((b) => b.issues + b.prs + b.deps));
  const nice = max <= 10 ? 10 : Math.ceil(max / 20) * 20;
  const bw = (w - left) / buckets.length;
  let svg = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Open work by age">`;
  for (const t of [0, nice / 2, nice]) {
    const y = r1(16 + plotH - (t / nice) * plotH);
    svg += `<line x1="${left}" x2="${w}" y1="${y}" y2="${y}" class="grid-line"/><text x="${left - 6}" y="${y + 4}" text-anchor="end" class="axis-label">${t}</text>`;
  }
  buckets.forEach((b, i) => {
    const x = left + i * bw + bw * 0.2;
    const width = bw * 0.6;
    let base = 16 + plotH;
    for (const s of AGING_SERIES) {
      const v = b[s.key];
      if (!v) continue;
      const hh = (v / nice) * plotH;
      base -= hh;
      svg += `<rect x="${r1(x)}" y="${r1(base)}" width="${r1(width)}" height="${r1(Math.max(1, hh))}" rx="3" class="${s.cls} mark" data-tip="${esc(`${b.label} old\n${s.label}: ${v}`)}"/>`;
    }
    const total = b.issues + b.prs + b.deps;
    svg += `<text x="${r1(x + width / 2)}" y="${r1(base - 5)}" text-anchor="middle" class="value-label">${total}</text>`;
    svg += `<text x="${r1(x + width / 2)}" y="${h - 6}" text-anchor="middle" class="axis-label">${esc(b.label)}</text>`;
  });
  svg += `<line x1="${left}" x2="${w}" y1="${16 + plotH}" y2="${16 + plotH}" class="baseline"/></svg>`;
  const legend = AGING_SERIES.map((s) => `<li><span class="swatch ${s.cls}"></span>${s.label}</li>`).join("");
  return trusted(`<ul class="legend">${legend}</ul><div class="chart">${svg}</div>`);
}

export function heatmap(rows: Array<{ name: string; weeks: number[] }>, endIso: string): SafeHtml {
  const cell = 16;
  const gap = 3;
  const labelW = 196;
  const weeks = rows[0]?.weeks.length ?? 26;
  const w = labelW + weeks * (cell + gap) + 8;
  const top = 22;
  const h = top + rows.length * (cell + gap) + 4;
  const level = (v: number) => (v === 0 ? 0 : v < 3 ? 1 : v < 6 ? 2 : v < 12 ? 3 : v < 25 ? 4 : 5);
  const end = Date.parse(endIso);
  let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Weekly commits on the default branch over ${weeks} weeks for ${rows.length} repositories">`;
  for (let i = 0; i < weeks; i += 4) {
    const d = new Date(end - (weeks - 1 - i) * 7 * 86_400_000);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    svg += `<text x="${labelW + i * (cell + gap)}" y="12" class="axis-label">${esc(label)}</text>`;
  }
  rows.forEach((row, ri) => {
    const y = top + ri * (cell + gap);
    const short = row.name.split("/")[1] ?? row.name;
    svg += `<text x="${labelW - 8}" y="${y + cell - 4}" text-anchor="end">${esc(short.length > 28 ? short.slice(0, 27) + "…" : short)}</text>`;
    row.weeks.forEach((v, wi) => {
      const weekStart = new Date(end - (weeks - wi) * 7 * 86_400_000).toISOString().slice(0, 10);
      svg += `<rect x="${labelW + wi * (cell + gap)}" y="${y}" width="${cell}" height="${cell}" rx="3" class="q${level(v)}" data-tip="${esc(`${short}\nweek of ${weekStart}: ${v} commit${v === 1 ? "" : "s"}`)}"/>`;
    });
  });
  svg += `</svg>`;
  const legend =
    `<ul class="legend"><li>Commits per week:</li>` +
    ["0", "1-2", "3-5", "6-11", "12-24", "25+"].map((l, i) => `<li><span class="swatch q${i}"></span>${l}</li>`).join("") +
    `</ul>`;
  return trusted(`${legend}<div class="heat-wrap chart">${svg}</div>`);
}

export function meter(fraction: number, label: string): SafeHtml {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return trusted(
    `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${esc(label)}"><svg viewBox="0 0 100 10" preserveAspectRatio="none"><rect class="fill" x="0" y="0" height="10" width="${r1(pct)}"/></svg></div>`,
  );
}
