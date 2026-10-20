import type { WorkItem } from '../../api/types';

/**
 * Offline "My work": the last list of open work seen on this device, kept in local storage (on this device only) so the installed app can
 * still show what is on your plate without a connection. Cleared when you sign out. No UI or store imports here, so the auth store can use it.
 */
const KEY = 'pm_offline_mywork';
export interface OfflineSnapshot {
  savedAt: string; user: string; workspace: string;
  items: Pick<WorkItem, 'kind' | 'id' | 'key' | 'title' | 'projectName' | 'status' | 'priority' | 'dueDate' | 'isOverdue'>[];
}

export function saveOfflineSnapshot(items: WorkItem[], user: string, workspace: string) {
  try {
    const snap: OfflineSnapshot = {
      savedAt: new Date().toISOString(), user, workspace,
      items: items.slice(0, 200).map((i) => ({ kind: i.kind, id: i.id, key: i.key, title: i.title, projectName: i.projectName, status: i.status, priority: i.priority, dueDate: i.dueDate, isOverdue: i.isOverdue })),
    };
    localStorage.setItem(KEY, JSON.stringify(snap));
  } catch { /* storage unavailable or full: offline view simply has nothing */ }
}

export function readOfflineSnapshot(): OfflineSnapshot | null {
  try { const raw = localStorage.getItem(KEY); return raw ? JSON.parse(raw) as OfflineSnapshot : null; } catch { return null; }
}

/** Forgets everything this person left on the device: the snapshot and the service worker's cached pages. */
/** Kept across sign-outs: device preferences, not anyone's data. */
const DEVICE_KEYS = new Set(['pm_theme', 'pm_alerts_prompt', 'pm_hint']);

export function clearOfflineData() {
  try {
    localStorage.removeItem(KEY);
    // Everything else this app (or an older version of it) cached for the person - chat threads, layouts, recent items - goes too.
    for (const k of Object.keys(localStorage)) {
      if (DEVICE_KEYS.has(k) || /remember|email/i.test(k)) continue;
      if (/^(pm_|pt|pf)/i.test(k) || /cache/i.test(k)) localStorage.removeItem(k);
    }
    sessionStorage.clear();
  } catch { /* ignore */ }
  navigator.serviceWorker?.controller?.postMessage('clear');
}
