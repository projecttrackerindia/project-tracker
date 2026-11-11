import { isNativeApp } from '../../lib/native';

/**
 * The Android app's own Today widget and ongoing timers (apps/android/native/quick: WidgetBridgePlugin, LiveTimerPlugin). Present only in a
 * build with the native quick layer; everywhere else (the web, the desktop app, an older APK) these do nothing.
 */
type Plugins = { WidgetBridge?: { set: (g: Glance) => Promise<void> }; LiveTimer?: { start: (t: LiveTimer) => Promise<void>; stop: (t: { kind: string }) => Promise<void> } };
const plugins = (): Plugins => (isNativeApp() ? ((window as unknown as { Capacitor?: { Plugins?: Plugins } }).Capacitor?.Plugins ?? {}) : {});

export type Glance = { tasks: { title: string }[]; meeting: { title: string; time: string; link: string } | null; checkInPercent: number; checkInLabel: string };
export type LiveTimer = { kind: 'workday' | 'call' | 'meeting'; title: string; body?: string; since: number; link: string };

export const hasNativeQuick = () => !!plugins().WidgetBridge || !!plugins().LiveTimer;

/** The widget's snapshot; the same one is not sent twice. */
let lastGlance = '';
export function setGlance(g: Glance) {
  const p = plugins().WidgetBridge;
  const json = JSON.stringify(g);
  if (!p || json === lastGlance) return;
  lastGlance = json;
  p.set(g).catch(() => { lastGlance = ''; });
}

/** One running timer per kind; starting the same one again (same since) is a no-op. */
const running = new Map<string, number>();
export function startTimer(t: LiveTimer) {
  const p = plugins().LiveTimer;
  if (!p || running.get(t.kind) === t.since) return;
  running.set(t.kind, t.since);
  p.start(t).catch(() => running.delete(t.kind));
}
export function stopTimer(kind: LiveTimer['kind']) {
  const p = plugins().LiveTimer;
  if (!p || !running.has(kind)) return;
  running.delete(kind);
  p.stop({ kind }).catch(() => undefined);
}

/** Glance from the data the web layer already has (pure, tested). */
export function buildGlance(work: { title: string }[], meeting: { title: string; start: string; joinUrl?: string | null; ref?: string } | null, checkIn: { checkInAt: string; checkOutAt: string | null; minutes?: number } | null, now = Date.now()): Glance {
  const mins = checkIn ? (checkIn.checkOutAt ? checkIn.minutes ?? 0 : Math.max(0, Math.round((now - Date.parse(checkIn.checkInAt)) / 60000))) : 0;
  const hm = `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
  const time = meeting ? new Date(meeting.start).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }) : '';
  const link = meeting ? (meeting.joinUrl?.startsWith('/') ? meeting.joinUrl : meeting.ref ? `/meetings?open=${encodeURIComponent(meeting.ref)}` : '/meetings') : '/';
  return {
    tasks: work.slice(0, 3).map((w) => ({ title: w.title.slice(0, 80) })),
    meeting: meeting ? { title: meeting.title.slice(0, 80), time, link } : null,
    checkInPercent: Math.min(100, Math.round((mins / 480) * 100)),
    checkInLabel: !checkIn ? 'Not checked in' : checkIn.checkOutAt ? `Out · ${hm}` : `In · ${hm}`,
  };
}
