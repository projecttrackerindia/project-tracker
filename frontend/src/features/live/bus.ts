import { HubConnectionState, type HubConnection } from '@microsoft/signalr';

/**
 * The app's one live connection (opened by ChatRealtime) shared with the screens that want live features: who else is viewing a task,
 * and calling the hub. Kept in its own module so neither side imports the other.
 */
let connection: HubConnection | null = null;
export const setLiveConnection = (c: HubConnection | null) => { connection = c; reconnectListeners.forEach((l) => l()); };

/** Calls a hub method when connected; quietly does nothing otherwise (live features are best effort). */
export function hubInvoke(method: string, ...args: unknown[]) {
  if (connection?.state === HubConnectionState.Connected) void connection.invoke(method, ...args).catch(() => { /* best effort */ });
}

export interface ViewingEvent { key: string; userId: string; name?: string | null; on: boolean; hello?: boolean }
const viewingListeners = new Set<(e: ViewingEvent) => void>();
const reconnectListeners = new Set<() => void>();
export const emitViewing = (e: ViewingEvent) => viewingListeners.forEach((l) => l(e));
export function onViewing(l: (e: ViewingEvent) => void) { viewingListeners.add(l); return () => { viewingListeners.delete(l); }; }
/** Called when the connection is (re)established, so screens can announce themselves again. */
export function onLiveConnected(l: () => void) { reconnectListeners.add(l); return () => { reconnectListeners.delete(l); }; }
export const notifyLiveConnected = () => reconnectListeners.forEach((l) => l());
