import { ApiClient, ApiProblem, type Exchange, type Transport } from "./api-client.ts";
import { html, mount, safeGithubUrl, trusted, type SafeHtml } from "./html.ts";
import {
  GROUPS, agingChart, bandBadge, breakdownChart, breakdownTable, ciDonut, heatmap, meter, scoreRing, sparkline,
  type AgingBucket, type Band, type BreakdownRow, type GroupId,
} from "./charts.ts";

declare const __IN_BROWSER_API__: boolean;

// ---------- API shapes (subset the UI reads) ----------
interface Signal { id: string; group: GroupId; points: number; reason: string }
interface Attention { score: number; band: Band; signals: Signal[] }
interface RepoSummary {
  fullName: string; priority: string; pinned: boolean; description: string | null; language: string | null; htmlUrl: string;
  attention: Attention | null;
  counts: { openIssues: number; openPulls: number; dependencyPulls: number; openNextActions: number; overdueNextActions: number } | null;
  ci: { status: "passing" | "failing" | "running" | "none"; failingWorkflows: string[]; lastRunAt: string | null; url: string | null } | null;
  lastCommitAt: string | null; pushedAt: string | null; weeklyCommits: number[] | null;
  sync: { state: "ok" | "error"; detail?: string };
  links: Record<string, string>;
}
interface RepoDetail extends RepoSummary {
  notes: string; topics: string[]; stars: number | null; defaultBranch: string | null; latestRelease: { tag: string; publishedAt: string | null; url: string } | null;
  commitsSinceRelease: number | null; ciRecent: Array<{ workflow: string; conclusion: string | null; status: string | null; at: string; url: string }>;
}
interface Page<T> { data: T[]; page: { limit: number; nextCursor: string | null }; total?: number }
interface AttentionReport {
  generatedAt: string;
  summary: { tracked: number; byBand: Record<Band, number>; openIssues: number; openPulls: number; dependencyPulls: number; failingCi: number; overdueNextActions: number };
  workAging: AgingBucket[];
  queue: RepoSummary[];
}
interface Upstream {
  mode: "live" | "snapshot";
  snapshot: { recordedAt: string; catalog: string[] } | null;
  github: {
    apiVersion: string;
    rate: { limit: number | null; remaining: number | null; resetAt: string | null };
    cache: { entries: number; requests: number; fresh: number; coalesced: number; revalidated: number; network: number; stale: number; retries: number; errors: number };
    budgetSaved: number;
    hitRatio: number | null;
  };
}
interface Settings { priority: string; notes: string; pinned: boolean; updatedAt: string }
interface WorkItem { number: number; kind: "issue" | "pr"; title: string; author: string; dependency: boolean; draft: boolean; ageDays: number; htmlUrl: string; labels: Array<{ name: string }> }
interface ActivityEvent { id: string; kind: string; actor: string; at: string; summary: string }
interface NextAction { id: string; repo: string; title: string; dueOn: string | null; status: "open" | "done"; links: { self: string } }

// ---------- state ----------
const state = {
  api: null as unknown as ApiClient,
  reset: null as null | (() => void),
  mode: "live" as "live" | "snapshot",
  now: Date.now(),
  catalog: [] as string[],
  all: [] as RepoSummary[],
  list: [] as RepoSummary[],
  report: null as AttentionReport | null,
  upstream: null as Upstream | null,
  bands: new Set<Band>(),
  sort: "-attention",
  breakdownTable: false,
  showAll: false,
  exchanges: [] as Exchange[],
  openExchange: null as number | null,
  drawer: null as null | { fullName: string; itemType: string; items: WorkItem[]; itemsCursor: string | null; itemsTotal: number },
};

const $ = (sel: string) => document.querySelector(sel);
const DAY = 86_400_000;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const d = Math.floor((state.now - Date.parse(iso)) / DAY);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 60) return `${d} days ago`;
  return `${Math.round(d / 30)} months ago`;
}
const short = (fullName: string) => fullName.split("/")[1] ?? fullName;
const repoPath = (fullName: string) => `/api/v1/repos/${fullName.split("/").map(encodeURIComponent).join("/")}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function problemText(err: unknown): string {
  if (err instanceof ApiProblem) {
    const fields = err.problem.errors?.map((e) => `${e.pointer || "body"} ${e.detail}`).join("; ");
    return `${err.problem.status} ${err.problem.title}${fields ? `: ${fields}` : err.problem.detail ? `: ${err.problem.detail}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------- data ----------
function listPath(): string {
  const q = new URLSearchParams({ limit: "50", sort: state.sort });
  if (state.bands.size) q.set("band", [...state.bands].join(","));
  return `/api/v1/repos?${q.toString()}`;
}

async function refresh(revalidate = false): Promise<void> {
  const [report, all] = await Promise.all([
    state.api.get<AttentionReport>("/api/v1/attention?limit=50", { revalidate }),
    state.api.get<Page<RepoSummary>>("/api/v1/repos?limit=50&sort=-attention", { revalidate }),
  ]);
  state.report = report.data;
  state.all = all.data.data;
  state.list = state.bands.size || state.sort !== "-attention" ? (await state.api.get<Page<RepoSummary>>(listPath())).data.data : state.all;
  state.upstream = (await state.api.get<Upstream>("/api/v1/meta/upstream")).data;
  renderAll();
}

// ---------- rendering ----------
function renderAll(): void {
  renderBadge();
  renderKpis();
  renderFilters();
  renderQueue();
  renderCharts();
  renderUpstream();
  renderCatalog();
}

function renderBadge(): void {
  const live = state.mode === "live";
  const rec = state.upstream?.snapshot?.recordedAt;
  mount(
    $("#mode-badge"),
    html`<span class="dot ${live ? "" : "demo"}"></span>${live ? "Live · GitHub REST API" : `Demo · snapshot ${rec ? rec.slice(0, 10) : ""}`}`,
  );
  if (!live) {
    mount(
      $("#notice"),
      html`<div class="notice"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 4.5v.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <span>Demo mode: ${__IN_BROWSER_API__ ? "the full REST API runs in your browser against" : "the API server replays"} GitHub responses recorded from ${state.upstream?.snapshot?.catalog.length ?? 0} public repositories on ${rec?.slice(0, 10) ?? ""} (the clock is frozen at that moment). Priorities and next actions are sample entries; ${__IN_BROWSER_API__ ? "your edits stay in this browser" : "edits live in server memory until it restarts"}.
        <button class="btn small" type="button" data-action="reset-demo">Reset demo</button></span></div>`,
    );
  }
  mount($("#footer-meta"), html`GitHub REST API version ${state.upstream?.github.apiVersion ?? ""}`);
}

function kpi(label: string, value: string | number, sub: string, cls = ""): SafeHtml {
  return html`<div class="card kpi fx-spot"><span class="label">${label}</span><span class="value ${cls}">${value}</span><span class="sub">${sub}</span></div>`;
}

function renderKpis(): void {
  const s = state.report?.summary;
  const u = state.upstream?.github;
  if (!s || !u) return;
  const need = s.byBand.critical + s.byBand.high;
  mount(
    $("#kpis"),
    html`${kpi("Need attention", need, `${s.byBand.critical} critical of ${s.tracked} tracked`, s.byBand.critical ? "critical" : "")}
    ${kpi("Failing CI", s.failingCi, "default-branch workflows", s.failingCi ? "critical" : "")}
    ${kpi("PRs awaiting review", s.openPulls, `${s.dependencyPulls} dependency updates open`)}
    ${kpi("Open issues", s.openIssues, `across ${s.tracked} repositories`)}
    ${kpi("Overdue next actions", s.overdueNextActions, "owner follow-ups past due", s.overdueNextActions ? "critical" : "")}
    ${kpi("GitHub calls saved", u.budgetSaved, `${u.hitRatio === null ? "-" : Math.round(u.hitRatio * 100) + "%"} served by cache or 304`)}`,
  );
}

function renderFilters(): void {
  const by = state.report?.summary.byBand;
  const bands: Band[] = ["critical", "high", "watch", "healthy"];
  mount(
    $("#filters"),
    html`${bands.map(
      (b) => html`<button class="chip" type="button" data-action="band" data-band="${b}" aria-pressed="${state.bands.has(b)}">${bandBadge(b)} ${by?.[b] ?? 0}</button>`,
    )}${state.bands.size ? html`<button class="chip" type="button" data-action="band-clear">Clear</button>` : ""}`,
  );
}

function repoCard(r: RepoSummary): SafeHtml {
  const a = r.attention;
  if (!a || r.sync.state === "error") {
    return html`<div class="repo" role="listitem"><div></div><div><div class="name">${r.fullName}</div><ul class="reasons"><li>GitHub data unavailable: ${r.sync.detail ?? "unknown error"}</li></ul></div><div></div></div>`;
  }
  const [owner, name] = r.fullName.split("/");
  const ci = r.ci?.status ?? "none";
  return html`<button class="repo" type="button" data-action="open" data-repo="${r.fullName}" aria-label="${r.fullName}, score ${a.score}, ${a.band}">
    ${scoreRing(a.score, a.band)}
    <div>
      <div class="name"><span class="owner">${owner}/</span>${name}</div>
      <ul class="reasons">${a.signals.slice(0, 3).map((s) => html`<li>${s.reason}</li>`)}${a.signals.length === 0 ? html`<li>Nothing needs you here</li>` : ""}</ul>
      <div class="meta">
        <span class="tag">${r.priority}</span>${r.pinned ? html`<span class="tag pin">pinned</span>` : ""}
        <span class="tag">CI ${ci}</span>
        ${r.counts ? html`<span class="tag">${plural(r.counts.openIssues, "issue")}</span><span class="tag">${plural(r.counts.openPulls + r.counts.dependencyPulls, "PR")}</span>` : ""}
        ${r.language ? html`<span class="tag">${r.language}</span>` : ""}
      </div>
    </div>
    <div class="repo-side">${bandBadge(a.band)}${r.weeklyCommits ? sparkline(r.weeklyCommits, `${r.fullName} weekly commits`) : ""}<span class="muted mono">last commit ${ago(r.lastCommitAt)}</span></div>
  </button>`;
}

const QUEUE_PREVIEW = 8;

function renderQueue(): void {
  const items = state.list;
  const shown = state.showAll ? items : items.slice(0, QUEUE_PREVIEW);
  const more = items.length - shown.length;
  mount(
    $("#queue-list"),
    items.length
      ? html`${shown.map(repoCard)}${
          items.length > QUEUE_PREVIEW
            ? html`<button class="btn show-all" type="button" data-action="show-all" aria-expanded="${state.showAll}">${state.showAll ? "Show top 8" : `Show all ${items.length} (${more} more)`}</button>`
            : ""
        }`
      : html`<div class="empty">No repositories match these filters.</div>`,
  );
}

function renderCharts(): void {
  const ranked = state.all.filter((r) => r.attention).sort((a, b) => b.attention!.score - a.attention!.score).slice(0, 10);
  const rows: BreakdownRow[] = ranked.map((r) => {
    const groups = { delivery: 0, review: 0, maintenance: 0, owner: 0 } as Record<GroupId, number>;
    for (const s of r.attention!.signals) groups[s.group] += s.points;
    return { name: r.fullName, score: r.attention!.score, band: r.attention!.band, groups, reasons: r.attention!.signals.map((s) => s.reason) };
  });
  const legend = html`<ul class="legend">${GROUPS.map((g) => html`<li><span class="swatch ${g.cls}"></span>${g.label}</li>`)}</ul>`;
  mount($("#breakdown"), state.breakdownTable ? breakdownTable(rows) : html`${legend}<div class="chart">${breakdownChart(rows)}</div>`);
  const btn = document.querySelector('[data-action="toggle-breakdown-table"]');
  btn?.setAttribute("aria-pressed", String(state.breakdownTable));
  if (btn) btn.textContent = state.breakdownTable ? "Chart view" : "Table view";

  const counts = { failing: 0, passing: 0, running: 0, none: 0 };
  for (const r of state.all) if (r.ci) counts[r.ci.status] += 1;
  mount($("#ci"), ciDonut(counts));
  if (state.report) mount($("#aging"), agingChart(state.report.workAging));
  const heatRows = [...state.all]
    .filter((r) => r.weeklyCommits)
    .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? ""))
    .map((r) => ({ name: r.fullName, weeks: r.weeklyCommits! }));
  mount($("#heatmap"), heatmap(heatRows, new Date(state.now).toISOString()));
}

function renderUpstream(): void {
  const u = state.upstream?.github;
  if (!u) return;
  const c = u.cache;
  const limit = u.rate.limit ?? 5000;
  const remaining = u.rate.remaining ?? limit;
  mount(
    $("#upstream"),
    html`<div class="row"><span class="muted">Primary rate limit remaining</span><b class="mono">${remaining} / ${limit}</b></div>
    ${meter(remaining / limit, "GitHub rate limit remaining")}
    <dl class="stats">
      <div><dt>Served from fresh cache</dt><dd>${c.fresh}</dd></div>
      <div><dt>Revalidated (304, free)</dt><dd>${c.revalidated}</dd></div>
      <div><dt>Coalesced in flight</dt><dd>${c.coalesced}</dd></div>
      <div><dt>Full responses (200)</dt><dd>${c.network}</dd></div>
      <div><dt>Retries / stale served</dt><dd>${c.retries} / ${c.stale}</dd></div>
      <div><dt>Cached resources</dt><dd>${c.entries}</dd></div>
    </dl>
    <p class="muted">Press <b>Revalidate</b>: the dashboard sends <span class="mono">Cache-Control: no-cache</span>, the API re-asks GitHub with <span class="mono">If-None-Match</span>, and unchanged resources come back as 304s that cost no rate-limit budget.</p>`,
  );
}

function renderCatalog(): void {
  const tracked = new Set(state.all.map((r) => r.fullName.toLowerCase()));
  const options = state.catalog.filter((c) => !tracked.has(c.toLowerCase()));
  mount($("#catalog"), html`${options.map((o) => html`<option value="${o}"></option>`)}`);
  const input = $("#connect-input") as HTMLInputElement | null;
  if (input && state.mode === "snapshot" && options[0]) input.placeholder = `owner/name, e.g. ${options[0]}`;
}

function statusClass(s: number): string {
  return s === 304 ? "nm" : s < 300 ? "ok" : s < 500 ? "cl" : "sv";
}

function renderInspector(): void {
  const rows = state.exchanges.map((e) => {
    const open = state.openExchange === e.id;
    const etag = e.resHeaders.find(([k]) => k === "etag")?.[1];
    return html`<tr class="ex" data-action="exchange" data-id="${e.id}" aria-expanded="${open}">
        <td class="mono">${new Date(e.at).toLocaleTimeString()}</td><td class="mono">${e.method}</td>
        <td class="mono">${e.path}</td><td class="status ${statusClass(e.status)}">${e.status}</td>
        <td class="num mono">${e.ms} ms</td><td class="mono">${etag ? etag.slice(0, 12) + "…" : ""}</td><td>${e.note}</td></tr>
      ${open
        ? html`<tr><td colspan="7"><div class="hdrs">${e.reqHeaders.map(([k, v]) => `> ${k}: ${v}\n`).join("")}${e.resHeaders.map(([k, v]) => `< ${k}: ${v}\n`).join("")}</div>${e.body ? html`<pre class="body">${pretty(e.body)}</pre>` : ""}</td></tr>`
        : ""}`;
  });
  mount(
    $("#inspector"),
    html`<table class="data"><thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th class="num">Time</th><th>ETag</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
}

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2).slice(0, 6000);
  } catch {
    return body;
  }
}

// ---------- drawer ----------
async function openDrawer(fullName: string): Promise<void> {
  state.drawer = { fullName, itemType: "all", items: [], itemsCursor: null, itemsTotal: 0 };
  history.replaceState(null, "", `#repo=${encodeURIComponent(fullName)}`);
  const drawer = $("#drawer")!;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  $("#scrim")!.classList.add("open");
  mount($("#drawer-head"), html`<h2 id="drawer-title">${fullName}</h2>`);
  mount($("#drawer-body"), html`<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`);
  await renderDrawer();
  (drawer.querySelector("[data-action=close-drawer]") as HTMLElement | null)?.focus();
}

function closeDrawer(): void {
  state.drawer = null;
  history.replaceState(null, "", location.pathname + location.search);
  $("#drawer")!.classList.remove("open");
  $("#drawer")!.setAttribute("aria-hidden", "true");
  $("#scrim")!.classList.remove("open");
}

async function loadItems(append: boolean): Promise<void> {
  const d = state.drawer!;
  const q = new URLSearchParams({ type: d.itemType, limit: "10" });
  if (append && d.itemsCursor) q.set("cursor", d.itemsCursor);
  const res = await state.api.get<Page<WorkItem>>(`${repoPath(d.fullName)}/issues?${q.toString()}`);
  d.items = append ? [...d.items, ...res.data.data] : res.data.data;
  d.itemsCursor = res.data.page.nextCursor;
  d.itemsTotal = res.data.total ?? d.items.length;
}

async function renderDrawer(): Promise<void> {
  const d = state.drawer;
  if (!d) return;
  const base = repoPath(d.fullName);
  try {
    const [detail, settings, activity, actions] = await Promise.all([
      state.api.get<RepoDetail>(base),
      state.api.get<Settings>(`${base}/settings`),
      state.api.get<Page<ActivityEvent> & { ciRecent: RepoDetail["ciRecent"] }>(`${base}/activity?limit=12`),
      state.api.get<Page<NextAction>>(`${base}/next-actions?status=all&limit=50`),
      loadItems(false),
    ]);
    if (state.drawer?.fullName !== d.fullName) return;
    const r = detail.data;
    const s = settings.data;
    const a = r.attention;
    mount(
      $("#drawer-head"),
      html`${a ? scoreRing(a.score, a.band) : ""}<div><h2 id="drawer-title">${r.fullName}</h2>
        <p class="muted">${r.description ?? ""}</p>
        <div class="row">${a ? bandBadge(a.band) : ""}<a href="${safeGithubUrl(r.htmlUrl)}" target="_blank" rel="noopener noreferrer">Open on GitHub</a>
        ${r.latestRelease ? html`<span class="tag">release ${r.latestRelease.tag}${r.commitsSinceRelease !== null ? ` +${r.commitsSinceRelease}` : ""}</span>` : ""}</div></div>
        <button class="btn small" type="button" data-action="close-drawer" aria-label="Close details">Close</button>`,
    );
    const today = new Date(state.now).toISOString().slice(0, 10);
    mount(
      $("#drawer-body"),
      html`<section class="card"><h3>Score breakdown</h3>
        ${a && a.signals.length
          ? html`<ul class="signals">${a.signals.map((sg) => html`<li><span class="swatch ${GROUPS.find((g) => g.id === sg.group)?.cls ?? ""}"></span><span>${sg.reason}</span><span class="pts">+${sg.points}</span></li>`)}</ul>`
          : html`<p class="muted">No signals: nothing needs attention.</p>`}
      </section>

      <section class="card"><h3>Owner settings</h3>
        <form id="settings-form" class="stack">
          <div class="row">
            <label class="field">Priority <select class="select" name="priority">${["P0", "P1", "P2", "P3"].map((p) => html`<option value="${p}" ${p === s.priority ? trusted("selected") : ""}>${p}</option>`)}</select></label>
            <label class="field"><span>Pinned</span><input type="checkbox" name="pinned" ${s.pinned ? trusted("checked") : ""}></label>
          </div>
          <label class="field">Notes <textarea class="textarea" name="notes" maxlength="2000">${s.notes}</textarea></label>
          <div class="row"><button class="btn primary" type="submit">Save</button><span class="muted mono">PATCH · If-Match</span></div>
          <div class="form-msg" id="settings-msg" role="status"></div>
        </form>
      </section>

      <section class="card"><h3>Next actions</h3>
        <ul class="actions-list">${actions.data.data.map(
          (n) => html`<li class="${n.status}"><input type="checkbox" aria-label="Mark done: ${n.title}" data-action="toggle-action" data-id="${n.id}" ${n.status === "done" ? trusted("checked") : ""}>
            <span><span class="t">${n.title}</span><br><span class="due ${n.status === "open" && n.dueOn && n.dueOn < today ? "overdue" : ""}">${n.dueOn ? `due ${n.dueOn}` : "no due date"}</span></span>
            <button class="btn small danger" type="button" data-action="delete-action" data-id="${n.id}" aria-label="Delete ${n.title}">Delete</button></li>`,
        )}</ul>
        <form id="action-form" class="connect">
          <input class="input" name="title" placeholder="Next action" minlength="3" maxlength="200" required aria-label="Next action title">
          <input class="input" name="dueOn" type="date" aria-label="Due date">
          <button class="btn primary" type="submit">Add</button>
        </form>
        <div class="form-msg" id="action-msg" role="status"></div>
      </section>

      <section class="card"><div class="card-head"><h3>Open work (${d.itemsTotal})</h3>
        <div class="tabs">${["all", "issue", "pr", "dependency"].map((t) => html`<button class="chip" type="button" data-action="items-type" data-type="${t}" aria-pressed="${d.itemType === t}">${t === "pr" ? "PRs" : t === "dependency" ? "Dependencies" : t === "issue" ? "Issues" : "All"}</button>`)}</div></div>
        <div id="items">${itemsTable(d)}</div>
      </section>

      <section class="card"><h3>Recent activity</h3>
        ${activity.data.data.length
          ? html`<ol class="timeline">${activity.data.data.map((e) => html`<li><time datetime="${e.at}">${ago(e.at)}</time><span><b>${e.actor}</b> ${e.summary}</span></li>`)}</ol>`
          : html`<p class="muted">No public events in GitHub's 90-day event window.</p>`}
        <h3>CI runs on ${r.defaultBranch ?? "default branch"}</h3>
        <ol class="timeline">${r.ciRecent.slice(0, 6).map((c) => html`<li><time datetime="${c.at}">${ago(c.at)}</time><span>${c.workflow}: <b>${c.conclusion ?? c.status ?? "unknown"}</b></span></li>`)}</ol>
      </section>

      <section class="row"><button class="btn danger" type="button" data-action="disconnect" data-repo="${r.fullName}">Disconnect repository</button><span class="muted mono">DELETE ${base}</span></section>`,
    );
  } catch (err) {
    mount($("#drawer-body"), html`<div class="notice">Could not load ${d.fullName}: ${problemText(err)}</div>`);
  }
}

function itemsTable(d: NonNullable<typeof state.drawer>): SafeHtml {
  if (!d.items.length) return html`<p class="muted">Nothing open.</p>`;
  return html`<table class="data"><thead><tr><th>#</th><th>Title</th><th>Author</th><th class="num">Age</th></tr></thead><tbody>
    ${d.items.map((w) => html`<tr><td class="mono">${w.kind === "pr" ? "PR " : ""}${w.number}</td><td><a href="${safeGithubUrl(w.htmlUrl)}" target="_blank" rel="noopener noreferrer">${w.title}</a>${w.draft ? html` <span class="tag">draft</span>` : ""}</td><td class="mono">${w.author}</td><td class="num">${w.ageDays}d</td></tr>`)}
    </tbody></table>${d.itemsCursor ? html`<button class="btn small" type="button" data-action="items-more">Load more (keyset cursor)</button>` : ""}`;
}

// ---------- writes ----------
async function saveSettings(form: HTMLFormElement): Promise<void> {
  const d = state.drawer;
  if (!d) return;
  const path = `${repoPath(d.fullName)}/settings`;
  const fd = new FormData(form);
  const body = { priority: fd.get("priority"), notes: String(fd.get("notes") ?? ""), pinned: fd.get("pinned") === "on" };
  const msg = $("#settings-msg")!;
  try {
    const etag = state.api.etagOf(path) ?? (await state.api.get<Settings>(path)).headers.get("etag") ?? "";
    await state.api.send(`PATCH`, path, { body, headers: { "content-type": "application/merge-patch+json", "if-match": etag } });
    state.api.forget(path);
    await refresh();
    await renderDrawer();
    const saved = $("#settings-msg");
    if (saved) {
      saved.className = "form-msg ok";
      saved.textContent = "Saved. The attention score was recomputed.";
    }
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent =
      err instanceof ApiProblem && err.kind === "precondition-failed"
        ? "Someone changed these settings since you opened them. Reloaded the latest values; apply your change again."
        : problemText(err);
    if (err instanceof ApiProblem && err.kind === "precondition-failed") {
      state.api.forget(path);
      await renderDrawer();
    }
  }
}

async function addAction(form: HTMLFormElement): Promise<void> {
  const d = state.drawer;
  if (!d) return;
  const fd = new FormData(form);
  const dueOn = String(fd.get("dueOn") ?? "");
  const msg = $("#action-msg")!;
  try {
    await state.api.send("POST", `${repoPath(d.fullName)}/next-actions`, {
      body: { title: String(fd.get("title") ?? ""), dueOn: dueOn || null },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    await refresh();
    await renderDrawer();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = problemText(err);
  }
}

async function toggleAction(id: string, done: boolean): Promise<void> {
  const path = `/api/v1/next-actions/${encodeURIComponent(id)}`;
  try {
    state.api.forget(path);
    const current = await state.api.get<NextAction>(path);
    await state.api.send("PATCH", path, {
      body: { status: done ? "done" : "open" },
      headers: { "content-type": "application/merge-patch+json", "if-match": current.headers.get("etag") ?? "" },
    });
    state.api.forget(path);
    await refresh();
    await renderDrawer();
  } catch (err) {
    const msg = $("#action-msg");
    if (msg) {
      msg.className = "form-msg err";
      msg.textContent = problemText(err);
    }
  }
}

async function connect(form: HTMLFormElement): Promise<void> {
  const input = form.querySelector("input") as HTMLInputElement;
  const msg = $("#connect-msg")!;
  const btn = form.querySelector("button") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const res = await state.api.send<RepoSummary>("POST", "/api/v1/repos", {
      body: { fullName: input.value.trim() },
      headers: { "idempotency-key": crypto.randomUUID() },
    });
    msg.className = "form-msg ok";
    msg.textContent = `Connected ${res.data?.fullName ?? ""} (201 Created, Location: ${res.headers.get("location") ?? ""}).`;
    input.value = "";
    await refresh();
  } catch (err) {
    msg.className = "form-msg err";
    msg.textContent = problemText(err);
  } finally {
    btn.disabled = false;
  }
}

// ---------- events ----------
function wireEvents(): void {
  document.addEventListener("click", async (ev) => {
    const el = (ev.target as Element).closest<HTMLElement>("[data-action]");
    if (!el) return;
    const action = el.dataset["action"];
    switch (action) {
      case "open":
        if (el.dataset["repo"]) await openDrawer(el.dataset["repo"]);
        break;
      case "close-drawer":
        closeDrawer();
        break;
      case "band": {
        const b = el.dataset["band"] as Band;
        if (state.bands.has(b)) state.bands.delete(b);
        else state.bands.add(b);
        await refresh();
        break;
      }
      case "band-clear":
        state.bands.clear();
        await refresh();
        break;
      case "revalidate": {
        const btn = el as HTMLButtonElement;
        btn.disabled = true;
        try {
          await refresh(true);
        } finally {
          btn.disabled = false;
        }
        break;
      }
      case "show-all":
        state.showAll = !state.showAll;
        renderQueue();
        break;
      case "toggle-breakdown-table":
        state.breakdownTable = !state.breakdownTable;
        renderCharts();
        break;
      case "exchange": {
        const id = Number(el.dataset["id"]);
        state.openExchange = state.openExchange === id ? null : id;
        renderInspector();
        break;
      }
      case "clear-log":
        state.exchanges = [];
        renderInspector();
        break;
      case "items-type":
        if (state.drawer) {
          state.drawer.itemType = el.dataset["type"] ?? "all";
          await loadItems(false);
          mount($("#items"), itemsTable(state.drawer));
          document.querySelectorAll('[data-action="items-type"]').forEach((c) => c.setAttribute("aria-pressed", String((c as HTMLElement).dataset["type"] === state.drawer?.itemType)));
        }
        break;
      case "items-more":
        if (state.drawer) {
          await loadItems(true);
          mount($("#items"), itemsTable(state.drawer));
        }
        break;
      case "toggle-action":
        await toggleAction(el.dataset["id"] ?? "", (el as HTMLInputElement).checked);
        break;
      case "delete-action":
        try {
          await state.api.send("DELETE", `/api/v1/next-actions/${encodeURIComponent(el.dataset["id"] ?? "")}`);
          await refresh();
          await renderDrawer();
        } catch (err) {
          const msg = $("#action-msg");
          if (msg) msg.textContent = problemText(err);
        }
        break;
      case "disconnect":
        if (el.dataset["repo"] && confirm(`Disconnect ${el.dataset["repo"]}? Its next actions are deleted too.`)) {
          await state.api.send("DELETE", repoPath(el.dataset["repo"]));
          closeDrawer();
          await refresh();
        }
        break;
      case "reset-demo":
        state.reset?.();
        location.reload();
        break;
    }
  });

  document.addEventListener("submit", async (ev) => {
    const form = ev.target as HTMLFormElement;
    ev.preventDefault();
    if (form.id === "connect-form") await connect(form);
    else if (form.id === "settings-form") await saveSettings(form);
    else if (form.id === "action-form") await addAction(form);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && state.drawer) closeDrawer();
  });

  ($("#sort") as HTMLSelectElement).addEventListener("change", async (ev) => {
    state.sort = (ev.target as HTMLSelectElement).value;
    await refresh();
  });

  // Hover tooltip for chart marks.
  const tip = $("#tooltip") as HTMLElement;
  document.addEventListener("pointermove", (ev) => {
    const t = (ev.target as Element).closest?.("[data-tip]");
    if (!t) {
      tip.classList.remove("on");
      return;
    }
    tip.textContent = t.getAttribute("data-tip") ?? "";
    tip.classList.add("on");
    const x = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  });

  // Spotlight effect: pointer position as CSS custom properties.
  document.addEventListener("pointermove", (ev) => {
    const card = (ev.target as Element).closest?.(".fx-spot") as HTMLElement | null;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${ev.clientX - rect.left}px`);
    card.style.setProperty("--my", `${ev.clientY - rect.top}px`);
  });
}

function wireTheme(): void {
  const root = document.documentElement;
  const select = $("#theme") as HTMLSelectElement;
  select.value = root.dataset["theme"] ?? "bento";
  const save = () => {
    try {
      localStorage.setItem("gcc.theme", JSON.stringify({ theme: root.dataset["theme"], mode: root.dataset["mode"] }));
    } catch {
      /* storage unavailable: theme still applies for this visit */
    }
  };
  select.addEventListener("change", () => {
    root.dataset["theme"] = select.value;
    save();
  });
  $("#mode-toggle")!.addEventListener("click", () => {
    root.dataset["mode"] = root.dataset["mode"] === "dark" ? "light" : "dark";
    save();
  });
}

// ---------- boot ----------
async function boot(): Promise<void> {
  wireTheme();
  wireEvents();
  let transport: Transport;
  let origin = location.origin;
  if (__IN_BROWSER_API__) {
    const t = await (await import("./browser-transport.ts")).createBrowserTransport();
    transport = t.transport;
    state.reset = t.reset;
    origin = "https://command-center.demo";
  } else {
    transport = (req) => fetch(req);
  }
  state.api = new ApiClient(transport, origin);
  state.api.onExchange((e) => {
    state.exchanges.unshift(e);
    if (state.exchanges.length > 80) state.exchanges.length = 80;
    renderInspector();
  });
  const up = (await state.api.get<Upstream>("/api/v1/meta/upstream")).data;
  state.mode = up.mode;
  state.catalog = up.snapshot?.catalog ?? [];
  if (up.snapshot) state.now = Date.parse(up.snapshot.recordedAt);
  await refresh();
  // Deep link: #repo=owner/name opens that repository's drawer.
  const linked = /^#repo=(.+)$/.exec(location.hash)?.[1];
  if (linked) {
    let fullName = "";
    try {
      fullName = decodeURIComponent(linked);
    } catch {
      /* malformed hash: ignore it rather than fail the dashboard */
    }
    const match = state.all.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
    if (match) await openDrawer(match.fullName);
  }
}

boot().catch((err) => {
  mount($("#notice"), html`<div class="notice">The dashboard could not load: ${problemText(err)}</div>`);
});
