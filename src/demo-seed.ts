import type { Snapshot } from "./github/snapshot.ts";
import type { StoreState } from "./domain/store.ts";
import { fnv1a } from "./http/encoding.ts";

const DAY = 86_400_000;

/** Builds the demo workspace (sample priorities and next actions) from the snapshot seeds. */
export function seedState(snapshot: Snapshot): StoreState {
  const at = Date.parse(snapshot.recordedAt);
  const iso = (offsetDays: number) => new Date(at + offsetDays * DAY).toISOString();
  const day = (offsetDays: number) => iso(offsetDays).slice(0, 10);
  return {
    version: 1,
    repos: snapshot.workspace.map((w, i) => ({
      fullName: w.fullName,
      priority: w.priority,
      pinned: w.pinned ?? false,
      notes: w.notes ?? "",
      connectedAt: iso(-30 + i),
      updatedAt: iso(-3),
    })),
    nextActions: snapshot.nextActions.map((a, i) => ({
      id: `na_${fnv1a(`${a.repo}:${a.title}`)}${i}`,
      repo: a.repo,
      title: a.title,
      dueOn: a.dueInDays === null ? null : day(a.dueInDays),
      status: a.status ?? "open",
      createdAt: iso(-10 + i),
      updatedAt: iso(-2),
    })),
  };
}
