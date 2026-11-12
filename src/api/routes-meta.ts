import { json } from "../http/respond.ts";
import type { Router } from "../http/router.ts";
import { ApiError } from "../http/problem.ts";
import { hexToBytes, utf8 } from "../http/encoding.ts";
import { BANDS, WEIGHTS } from "../domain/attention.ts";
import { wantsRevalidate, type Services } from "./deps.ts";
import { loadAllViews, repoSummary } from "./views.ts";
import { allowQuery } from "./query.ts";
import { openApiDocument } from "./openapi.ts";

const RELEVANT_EVENTS = new Set(["push", "issues", "issue_comment", "pull_request", "pull_request_review", "workflow_run", "release", "repository"]);
const MAX_DELIVERIES = 500;

export function registerMetaRoutes(router: Router, s: Services): void {
  router.add("GET", "/api/v1", "apiIndex", ({ req }) =>
    json(req, {
      name: "github-command-center",
      version: "1",
      mode: s.mode,
      links: {
        attention: "/api/v1/attention",
        repos: "/api/v1/repos",
        nextActions: "/api/v1/next-actions",
        upstream: "/api/v1/meta/upstream",
        scoring: "/api/v1/meta/scoring",
        openapi: "/api/v1/openapi.json",
      },
    }),
  );

  router.add("GET", "/api/v1/openapi.json", "getOpenApi", ({ req }) => json(req, openApiDocument()));

  router.add("GET", "/api/v1/attention", "getAttention", async ({ req, url }) => {
    allowQuery(url, ["limit"]);
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw && /^\d{1,2}$/.test(limitRaw) ? Math.min(50, Math.max(1, Number(limitRaw))) : 10;
    const now = s.now();
    const views = await loadAllViews(s, wantsRevalidate(req));
    const items = views.map((v) => repoSummary(v, now));
    const scored = items.filter((i) => i.attention !== null);
    const byBand = { critical: 0, high: 0, watch: 0, healthy: 0, archived: 0 };
    for (const i of scored) byBand[i.attention!.band] += 1;
    const sum = (f: (i: (typeof items)[number]) => number) => items.reduce((acc, i) => acc + f(i), 0);
    // Open work by age across the workspace, for the aging histogram.
    const AGE_BUCKETS = [
      { label: "0-7d", max: 7 },
      { label: "8-30d", max: 30 },
      { label: "31-90d", max: 90 },
      { label: "90d+", max: Infinity },
    ];
    const workAging = AGE_BUCKETS.map((b) => ({ label: b.label, issues: 0, prs: 0, deps: 0 }));
    for (const v of views) {
      for (const w of [...(v.insight?.issues ?? []), ...(v.insight?.pulls ?? [])]) {
        const age = Math.floor((now - Date.parse(w.createdAt)) / 86_400_000);
        const bucket = workAging[AGE_BUCKETS.findIndex((b) => age <= b.max)]!;
        if (w.kind === "issue") bucket.issues++;
        else if (w.dependency) bucket.deps++;
        else bucket.prs++;
      }
    }
    const queue = scored
      .filter((i) => i.attention!.band !== "healthy" && i.attention!.band !== "archived")
      .sort((a, b) => b.attention!.score - a.attention!.score || a.fullName.localeCompare(b.fullName))
      .slice(0, limit);
    return json(req, {
      generatedAt: new Date(now).toISOString(),
      summary: {
        tracked: items.length,
        unavailable: items.length - scored.length,
        byBand,
        openIssues: sum((i) => i.counts?.openIssues ?? 0),
        openPulls: sum((i) => i.counts?.openPulls ?? 0),
        dependencyPulls: sum((i) => i.counts?.dependencyPulls ?? 0),
        failingCi: items.filter((i) => i.ci?.status === "failing").length,
        overdueNextActions: sum((i) => i.counts?.overdueNextActions ?? 0),
      },
      workAging,
      queue,
    });
  });

  router.add("GET", "/api/v1/meta/upstream", "getUpstreamStatus", ({ req }) => {
    const st = s.github.stats;
    const served = st.fresh + st.coalesced + st.revalidated + st.network + st.stale;
    return json(req, {
      mode: s.mode,
      snapshot: s.snapshot ?? null,
      github: {
        apiVersion: s.github.apiVersion,
        rate: s.github.rate,
        cache: { entries: s.github.cacheSize, ...st },
        // Requests that cost no primary rate-limit budget.
        budgetSaved: st.fresh + st.coalesced + st.revalidated,
        hitRatio: served === 0 ? null : Math.round(((st.fresh + st.coalesced + st.revalidated) / served) * 1000) / 1000,
      },
    });
  });

  router.add("GET", "/api/v1/meta/scoring", "getScoringModel", ({ req }) => json(req, { bands: BANDS, weights: WEIGHTS }));

  router.add("POST", "/api/v1/webhooks/github", "receiveGithubWebhook", async ({ req }) => {
    if (!s.webhookSecret) {
      throw new ApiError(503, "not-configured", "Webhooks not configured", "Set WEBHOOK_SECRET to enable GitHub webhook delivery");
    }
    const raw = await req.text();
    if (raw.length > 1_000_000) throw new ApiError(413, "payload-too-large", "Payload too large", "Webhook payload exceeds 1 MB");
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    if (!(await verifySignature(s.webhookSecret, raw, signature))) {
      throw new ApiError(401, "unauthorized", "Invalid signature", "X-Hub-Signature-256 does not match the payload");
    }
    const delivery = req.headers.get("x-github-delivery") ?? "";
    const event = req.headers.get("x-github-event") ?? "";
    if (delivery && s.deliveries.has(delivery)) {
      return json(req, { status: "duplicate", delivery }, { status: 200 });
    }
    if (delivery) {
      s.deliveries.add(delivery);
      if (s.deliveries.size > MAX_DELIVERIES) s.deliveries.delete(s.deliveries.values().next().value as string);
    }
    let fullName: string | undefined;
    try {
      const payload = JSON.parse(raw) as { repository?: { full_name?: unknown } };
      if (typeof payload.repository?.full_name === "string") fullName = payload.repository.full_name;
    } catch {
      throw new ApiError(400, "bad-request", "Malformed JSON", "Webhook payload is not valid JSON");
    }
    const tracked = fullName ? s.store.getRepo(fullName) : undefined;
    if (event === "ping" || !tracked || !RELEVANT_EVENTS.has(event)) {
      return json(req, { status: "ignored", event, delivery }, { status: 202 });
    }
    const invalidated = s.github.invalidateRepo(tracked.fullName);
    return json(req, { status: "accepted", event, delivery, repo: tracked.fullName, invalidated }, { status: 202 });
  });
}

/**
 * HMAC-SHA256 over the raw body, compared with WebCrypto's verify, which
 * checks the MAC without an early-exit string comparison.
 */
export async function verifySignature(secret: string, body: string, header: string): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header);
  const sig = m?.[1] ? hexToBytes(m[1]) : null;
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, utf8(body));
}
