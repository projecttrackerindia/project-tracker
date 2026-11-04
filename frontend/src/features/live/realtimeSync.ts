import type { Query, QueryClient } from '@tanstack/react-query';

/**
 * Realtime sync, the client half: the server sends a compact event for every committed change ("sync": type, id, project, op, version,
 * changed field names, actor - never values) to the people allowed to hear of it. Each event marks exactly the cached screens it touches
 * as stale - only those on screen reload, at most once per burst - instead of every work screen reloading, or waiting for a poll.
 *
 * - Updates refresh the cached reads that contain that id (a task row in a list, its panel, a board); a change that can move a row in or
 *   out of a list (status, assignee, dates, delete, create) refreshes that kind's lists.
 * - Each event is applied once (by version); my own save from this tab is skipped (MutationSync already refreshed it).
 * - After sleep, offline or a lost connection: "changes since version N" (the catch-up endpoint); a gap too old reloads the open screens.
 */
export interface SyncEvent {
  type: string; id: string | null; projectId: string | null; tenantId: string; op: 'created' | 'updated' | 'deleted' | 'restored';
  version: number; changedFields: string[] | null; actorId: string | null; action?: string; parentId?: string | null; at?: string;
}

/** Which cached reads (the key part after the workspace id) show each kind of thing. */
export const FAMILIES: Record<string, string[]> = {
  task: ['task', 'tasks', 'my-work', 'work-items', 'work', 'portfolio', 'plan-sheet', 'timeline', 'calendar', 'dashboard', 'dashboard-report', 'sprint-tasks', 'sprints', 'workload', 'capacity', 'project-status', 'project', 'inbox', 'activity', 'milestones'],
  actionItem: ['action-items', 'work', 'work-items', 'my-work', 'portfolio', 'plan-sheet', 'inbox', 'activity', 'project', 'timeline', 'calendar'],
  workTask: ['work', 'work-items', 'my-work', 'workload', 'inbox', 'activity', 'timeline', 'calendar', 'desk', 'support'],
  issue: ['issues', 'work-items', 'quality', 'project', 'activity'],
  milestone: ['milestones', 'timeline', 'portfolio', 'plan-sheet', 'project', 'project-status'],
  project: ['projects', 'project', 'portfolio', 'plan-sheet', 'dashboard', 'project-status', 'timeline'],
  projectMember: ['projects', 'project', 'portfolio'],
  comment: ['comments', 'activity', 'inbox'],
  reminder: ['reminders', 'inbox', 'timeline', 'calendar'],
  note: ['notes'],
  approval: ['approvals', 'inbox'],
  calendarEvent: ['calendar', 'meet', 'timeline', 'meetings'],
  timeEntry: ['time', 'timer', 'timesheet', 'timeline'],
  attendance: ['attendance', 'timeline'],
  deskTicket: ['support', 'desk'],
  chatUnread: ['chat'],
};

/** Field names that can move a row into or out of a list (or change a count), so the whole kind's lists refresh, not only rows holding the id. */
const MEMBERSHIP = /^(status|statusId|statusCategory|assignee|assigneeId|ownerId|dueDate|startDate|endDate|isDeleted|projectId|relatedProjectId|kind|completedAt|archived|archivedAt|readAt|state|decision|snoozedUntil|nextFireAt|teamId|stageId|parentTaskId|lastReadAt)$/i;

const text = new WeakMap<object, string>();
/** Whether a cached answer mentions this id (cached per answer object; answers are immutable in React Query). */
export function mentions(data: unknown, id: string): boolean {
  if (data == null) return false;
  if (typeof data !== 'object') return String(data).includes(id);
  let s = text.get(data as object);
  if (s === undefined) { try { s = JSON.stringify(data); } catch { s = ''; } text.set(data as object, s); }
  return s.includes(id);
}

/** The cached reads one event touches. Returns predicates over the query cache (the workspace id is always the first key part). */
export function touched(wid: string, e: SyncEvent): ((q: Query) => boolean)[] {
  const fams = new Set(FAMILIES[e.type] ?? []);
  if (fams.size === 0) return [];
  const inFamily = (q: Query) => q.queryKey[0] === wid && fams.has(String(q.queryKey[1]));
  const broad = e.op !== 'updated' || !e.changedFields || e.changedFields.length === 0 || e.changedFields.some((f) => MEMBERSHIP.test(f));
  const out: ((q: Query) => boolean)[] = [];
  if (broad) out.push(inFamily);
  else {
    const ids = [e.id, e.parentId].filter((x): x is string => !!x);
    out.push((q) => inFamily(q) && ids.some((id) => mentions(q.state.data, id)));
  }
  // A comment lives on its task / item: the reads holding that item (its panel, a row's comment count) refresh too.
  if (e.type === 'comment' && e.parentId) {
    const parent = e.parentId;
    out.push((q) => q.queryKey[0] === wid && ['task', 'tasks', 'work', 'work-items', 'action-items', 'my-work', 'issues'].includes(String(q.queryKey[1])) && mentions(q.state.data, parent));
  }
  return out;
}

export interface SyncOptions {
  client: QueryClient;
  wid: string;
  me: string | null | undefined;
  /** True right after this tab saved something (its own echo is then skipped: the save already refreshed what it changed). */
  ownRecent?: () => boolean;
  /** Something changed that may have notified me (someone else's change). */
  onForeign?: () => void;
  /** My project access changed: re-join the project groups. */
  onScope?: () => void;
  /** The gap was too old to catch up: reload every open work screen. */
  onReset?: () => void;
  load: (since: number) => Promise<{ version: number; reset: boolean; changes: SyncEvent[] }>;
  flushMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export interface Sync {
  apply(events: SyncEvent[]): void;
  /** Asks for everything since the last applied version (after start, reconnect, wake-up, back online). */
  catchUp(): Promise<void>;
  version(): number;
  dispose(): void;
  /** Applies whatever is queued now (tests). */
  flush(): Promise<void>;
}

export function createSync(o: SyncOptions): Sync {
  const key = `pm_rt_v_${o.wid}`;
  const store = o.storage === undefined ? (typeof localStorage === 'undefined' ? null : localStorage) : o.storage;
  let version = 0;
  try { version = Number(store?.getItem(key) ?? 0) || 0; } catch { version = 0; }
  const seen = new Set<number>();
  let pending: ((q: Query) => boolean)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let catching: Promise<void> | null = null;

  const remember = (v: number) => {
    if (v <= version) return;
    version = v;
    try { store?.setItem(key, String(v)); } catch { /* storage unavailable */ }
  };

  const flush = async () => {
    timer = undefined;
    const preds = pending;
    pending = [];
    if (!preds.length || disposed) return;
    // One pass over the cache for the whole burst; only reads on screen reload (others are marked stale). A touched read already in flight
    // may have left before the change was committed, so it is read again once it lands (never cancelled: no flicker, no wasted request).
    const hit = (q: Query) => preds.some((p) => p(q));
    const inFlight = o.client.getQueryCache().findAll({ predicate: (q) => hit(q) && q.state.fetchStatus === 'fetching' });
    await o.client.invalidateQueries({ predicate: hit }, { cancelRefetch: false });
    if (inFlight.length) {
      const again = new Set(inFlight);
      await o.client.invalidateQueries({ predicate: (q) => again.has(q) }, { cancelRefetch: false });
    }
  };

  const apply = (events: SyncEvent[]) => {
    if (disposed) return;
    let foreign = false, scope = false;
    for (const e of events) {
      if (e.tenantId && e.tenantId !== o.wid) continue;
      if (e.version > 0) {
        if (seen.has(e.version)) continue;
        seen.add(e.version);
        if (seen.size > 2000) { const first = seen.values().next().value; if (first !== undefined) seen.delete(first); }
      }
      // Advance only over what is contiguous with what we applied; a gap is closed by the catch-up.
      if (e.version > 0 && (version === 0 || e.version === version + 1)) remember(e.version);
      else if (e.version > version + 1 && version > 0) void catchUp();
      if (e.type === 'projectMember') scope = true;
      if (e.actorId !== o.me) foreign = true;
      if (e.actorId && e.actorId === o.me && o.ownRecent?.()) continue;
      pending.push(...touched(o.wid, e));
    }
    if (scope) o.onScope?.();
    if (foreign) o.onForeign?.();
    if (pending.length && timer === undefined) timer = setTimeout(() => void flush(), o.flushMs ?? 40);
  };

  const catchUp = (): Promise<void> => (catching ??= (async () => {
    try {
      const since = version;
      const r = await o.load(since);
      if (disposed) return;
      if (since === 0 || r.reset) {
        if (r.reset) o.onReset?.();
        version = 0;
        remember(r.version);
        return;
      }
      const missed = r.changes.filter((e) => e.version > since).sort((a, b) => a.version - b.version);
      // Applied as one burst; the version then jumps to the server's latest.
      const before = version;
      version = Number.MAX_SAFE_INTEGER;   // no gap-chasing while replaying
      apply(missed);
      version = before;
      remember(Math.max(r.version, ...missed.map((e) => e.version)));
    } catch { /* offline: the next reconnect or wake-up asks again */ }
    finally { catching = null; }
  })());

  return {
    apply, catchUp, version: () => version, flush: async () => { if (timer) clearTimeout(timer); await flush(); },
    dispose: () => { disposed = true; if (timer) clearTimeout(timer); },
  };
}
