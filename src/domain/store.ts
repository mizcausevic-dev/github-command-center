// Workspace state the owner controls: which repositories are tracked, their
// priority and notes, and next actions. GitHub data is never stored here; it
// is read through the cached client on demand.
//
// The store is synchronous and in-memory with an `onChange` hook, so the Node
// server persists it to a JSON file and the browser demo persists it to
// localStorage without either runtime leaking into the domain code.

export const PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const ACTION_STATUSES = ["open", "done"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export interface TrackedRepo {
  fullName: string;
  priority: Priority;
  notes: string;
  pinned: boolean;
  connectedAt: string;
  updatedAt: string;
}

export interface NextAction {
  id: string;
  repo: string;
  title: string;
  dueOn: string | null;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StoreState {
  version: 1;
  repos: TrackedRepo[];
  nextActions: NextAction[];
}

export const MAX_TRACKED_REPOS = 50;
export const MAX_ACTIONS_PER_REPO = 25;
export const MAX_TOTAL_ACTIONS_PER_REPO = 200;

const key = (fullName: string) => fullName.toLowerCase();

export class Store {
  private readonly repos = new Map<string, TrackedRepo>();
  private readonly actions = new Map<string, NextAction>();
  private readonly onChange: ((state: StoreState) => void) | undefined;

  constructor(initial?: StoreState, onChange?: (state: StoreState) => void) {
    for (const r of initial?.repos ?? []) this.repos.set(key(r.fullName), { ...r });
    for (const a of initial?.nextActions ?? []) this.actions.set(a.id, { ...a });
    this.onChange = onChange;
  }

  snapshot(): StoreState {
    return {
      version: 1,
      repos: [...this.repos.values()].map((r) => ({ ...r })),
      nextActions: [...this.actions.values()].map((a) => ({ ...a })),
    };
  }

  listRepos(): TrackedRepo[] {
    return [...this.repos.values()].map((r) => ({ ...r }));
  }

  getRepo(fullName: string): TrackedRepo | undefined {
    const r = this.repos.get(key(fullName));
    return r ? { ...r } : undefined;
  }

  addRepo(repo: TrackedRepo): void {
    this.repos.set(key(repo.fullName), { ...repo });
    this.changed();
  }

  updateRepo(fullName: string, patch: Partial<Omit<TrackedRepo, "fullName" | "connectedAt">>): TrackedRepo | undefined {
    const current = this.repos.get(key(fullName));
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.repos.set(key(fullName), next);
    this.changed();
    return { ...next };
  }

  /** Removes the repo and, as a cascade, its next actions. */
  removeRepo(fullName: string): boolean {
    const existed = this.repos.delete(key(fullName));
    if (!existed) return false;
    for (const [id, a] of this.actions) if (key(a.repo) === key(fullName)) this.actions.delete(id);
    this.changed();
    return true;
  }

  listActions(repo?: string): NextAction[] {
    const all = [...this.actions.values()];
    return (repo ? all.filter((a) => key(a.repo) === key(repo)) : all).map((a) => ({ ...a }));
  }

  getAction(id: string): NextAction | undefined {
    const a = this.actions.get(id);
    return a ? { ...a } : undefined;
  }

  addAction(action: NextAction): void {
    this.actions.set(action.id, { ...action });
    this.changed();
  }

  updateAction(id: string, patch: Partial<Omit<NextAction, "id" | "repo" | "createdAt">>): NextAction | undefined {
    const current = this.actions.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.actions.set(id, next);
    this.changed();
    return { ...next };
  }

  removeAction(id: string): boolean {
    const existed = this.actions.delete(id);
    if (existed) this.changed();
    return existed;
  }

  private changed(): void {
    this.onChange?.(this.snapshot());
  }
}

/** Validates untrusted persisted state (a hand-edited file or localStorage) before use. */
export function parseStoreState(raw: unknown): StoreState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const s = raw as Partial<StoreState>;
  if (s.version !== 1 || !Array.isArray(s.repos) || !Array.isArray(s.nextActions)) return undefined;
  const repoOk = (r: unknown): r is TrackedRepo => {
    const x = r as TrackedRepo;
    return (
      typeof x === "object" && x !== null && typeof x.fullName === "string" && PRIORITIES.includes(x.priority) &&
      typeof x.notes === "string" && typeof x.pinned === "boolean" && typeof x.connectedAt === "string" && typeof x.updatedAt === "string"
    );
  };
  const actionOk = (a: unknown): a is NextAction => {
    const x = a as NextAction;
    return (
      typeof x === "object" && x !== null && typeof x.id === "string" && typeof x.repo === "string" && typeof x.title === "string" &&
      (x.dueOn === null || typeof x.dueOn === "string") && ACTION_STATUSES.includes(x.status) &&
      typeof x.createdAt === "string" && typeof x.updatedAt === "string"
    );
  };
  if (!s.repos.every(repoOk) || !s.nextActions.every(actionOk)) return undefined;
  return { version: 1, repos: s.repos, nextActions: s.nextActions };
}
