import type { HubConnection } from '@microsoft/signalr';

/**
 * The app's one live connection (opened by ChatRealtime) shared with the screens that want live features: who else is viewing a task,
 * and calling the hub. Kept in its own module so neither side imports the other.
 */
let connection: HubConnection | null = null;
export const setLiveConnection = (c: HubConnection | null) => { connection = c; reconnectListeners.forEach((l) => l()); };

/** The live connection itself (for screens that keep their own event handlers on it, like co-editing a page); null before it is built. */
export const liveConnection = () => connection;
export const isLiveConnected = () => !!connection && String(connection.state) === 'Connected';

/** Calls a hub method and waits for its answer; null when not connected or the call failed. */
export async function hubCall<T>(method: string, ...args: unknown[]): Promise<T | null> {
  if (!isLiveConnected()) return null;
  try { return await connection!.invoke<T>(method, ...args); } catch { return null; }
}

/** Calls a hub method when connected; quietly does nothing otherwise (live features are best effort). */
export function hubInvoke(method: string, ...args: unknown[]) {
  // Compared by value: the connection library itself is only loaded once the live connection opens (see ChatRealtime).
  if (connection && String(connection.state) === 'Connected') void connection.invoke(method, ...args).catch(() => { /* best effort */ });
}

export interface ViewingEvent { key: string; userId: string; name?: string | null; on: boolean; hello?: boolean }
const viewingListeners = new Set<(e: ViewingEvent) => void>();
const reconnectListeners = new Set<() => void>();
export const emitViewing = (e: ViewingEvent) => viewingListeners.forEach((l) => l(e));
export function onViewing(l: (e: ViewingEvent) => void) { viewingListeners.add(l); return () => { viewingListeners.delete(l); }; }
/** A reminder just went off for the signed-in person (sent by the server to their open tabs). */
export interface ReminderEvent { id: string; title: string; note: string | null; targetKey: string | null; link: string | null; source: string; from: string | null;
  /** The occurrence this alert is about; Done/Snooze send it back so a second tap never finishes the next one. */ nextFireAt?: string | null; lastFiredAt?: string | null }
const reminderListeners = new Set<(e: ReminderEvent[]) => void>();
export const emitReminders = (e: ReminderEvent[]) => reminderListeners.forEach((l) => l(e));
export function onReminders(l: (e: ReminderEvent[]) => void) { reminderListeners.add(l); return () => { reminderListeners.delete(l); }; }

/** Called when the connection is (re)established, so screens can announce themselves again. */
export function onLiveConnected(l: () => void) { reconnectListeners.add(l); return () => { reconnectListeners.delete(l); }; }
export const notifyLiveConnected = () => reconnectListeners.forEach((l) => l());
