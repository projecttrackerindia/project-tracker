import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { getAttention, playRing, primeSound } from '../../lib/attention';
import { orgHref } from '../../lib/orgPath';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { CHECK_NOTIFICATIONS } from '../notifications/events';
import { callsApi } from './callsApi';
import { CALL_EVENT, expire, onRinging, ring, ringingCalls, stopRinging, type CallEventDetail, type IncomingCall } from './incomingCalls';
import './calls.css';

const RING_EVERY_MS = 3000;
const away = () => document.hidden || !document.hasFocus();
const swReady = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/** A system notification for a ringing call, with Answer and Decline (the service worker handles the buttons). */
async function showSystemRing(c: IncomingCall) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const link = orgHref(`/calls/${c.callId}`);
  const options: NotificationOptions & { renotify?: boolean; vibrate?: number[]; actions?: { action: string; title: string }[] } = {
    body: c.title, tag: `call-${c.callId}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', requireInteraction: true, renotify: true,
    // The page rings by itself when it can; when it cannot yet (no tap on it so far), the system notification makes the sound.
    silent: false, vibrate: [400, 200, 400, 200, 400],
    data: { link, call: c.callId },
    actions: [{ action: 'answer', title: 'Answer' }, { action: 'decline', title: 'Decline' }],
  };
  try {
    const reg = swReady() ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg?.active) { await reg.showNotification(`${c.fromName} is calling`, options); return; }
  } catch { /* fall back to a page notification */ }
  try {
    const { actions: _drop, ...plain } = options;   // only service-worker notifications can have buttons
    void _drop;
    const n = new Notification(`${c.fromName} is calling`, plain);
    n.onclick = () => { window.focus(); window.location.assign(link); n.close(); };
  } catch { /* not allowed here */ }
}

async function closeSystemRing(callId: string) {
  try {
    const reg = swReady() ? await navigator.serviceWorker.getRegistration() : undefined;
    for (const n of (await reg?.getNotifications({ tag: `call-${callId}` })) ?? []) n.close();
  } catch { /* nothing to close */ }
}

/**
 * The incoming-call card: drawn once beside every layout (desktop, phone, any page, Talk included), it rings with sound and shows who is
 * calling with Answer and Decline. In another tab or app it also shows a system notification with the same two buttons. It hears about
 * calls over the live connection, from pushes the service worker passes on, and - as a safety net when the live connection is down - from
 * the list of live calls, checked whenever notifications change, the tab comes back, and every 10 seconds.
 */
export function IncomingCallHost() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const me = useAuth((s) => s.ctx?.user.id);
  const wid = useAuth((s) => s.ctx?.current?.id);
  const [calls, setCalls] = useState<IncomingCall[]>(ringingCalls);
  const status = useWsQuery(['calls', 'status'], callsApi.status, { staleTime: 600_000, retry: false });
  const live = useWsQuery(['calls', 'live'], callsApi.live, { enabled: !!status.data?.available, refetchInterval: 10_000, refetchIntervalInBackground: true, retry: false });

  useEffect(() => { primeSound(); }, []);
  useEffect(() => onRinging((next) => {
    // A call that stopped ringing here (answered, declined, ended, missed): its system notification goes too.
    setCalls((prev) => { for (const c of prev) if (!next.some((n) => n.callId === c.callId)) void closeSystemRing(c.callId); return next; });
  }), []);

  // The live connection (and pushes passed on by the service worker).
  useEffect(() => {
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent<CallEventDetail>).detail;
      if (!d?.callId) return;
      if (d.event === 'incoming') ring({ callId: d.callId, title: d.title, fromName: d.fromName, startedAt: d.startedAt });
      else if (d.event === 'stopped') stopRinging(d.callId);
      else if (d.event === 'declined') toast(`${d.name || 'They'} declined the call`, 'info');
    };
    window.addEventListener(CALL_EVENT, onEvent);
    return () => window.removeEventListener(CALL_EVENT, onEvent);
  }, []);

  // The safety net: a call I was invited to, not in yet, that started moments ago.
  useEffect(() => {
    if (!me) return;
    for (const c of live.data ?? []) {
      if (c.status !== 'live' || c.startedBy === me) continue;
      const mine = c.people.find((p) => p.userId === me);
      if (!mine || mine.inCall || mine.joinedAt) continue;
      ring({ callId: c.id, title: c.title, fromName: c.startedByName, startedAt: c.startedAt });
    }
    // A call that is over (or that I joined elsewhere) stops ringing.
    const known = new Map((live.data ?? []).map((c) => [c.id, c]));
    // Only a list fetched well after the ring began says anything about it (one already on its way could predate the call).
    if (live.data) for (const r of ringingCalls()) {
      if (live.dataUpdatedAt < r.at + 3000) continue;
      const c = known.get(r.callId);
      if (!c || c.status !== 'live' || c.people.some((p) => p.userId === me && (p.inCall || p.joinedAt))) stopRinging(r.callId);
    }
  }, [live.data, live.dataUpdatedAt, me]);
  useEffect(() => {
    if (!wid) return;
    const check = () => { void qc.invalidateQueries({ queryKey: [wid, 'calls', 'live'] }); };
    const back = () => { if (!document.hidden) check(); };
    window.addEventListener(CHECK_NOTIFICATIONS, check);
    document.addEventListener('visibilitychange', back);
    return () => { window.removeEventListener(CHECK_NOTIFICATIONS, check); document.removeEventListener('visibilitychange', back); };
  }, [wid, qc]);

  // Buttons on the system notification (the service worker passes them on), and pushes for a call while this page is open.
  useEffect(() => {
    if (!swReady()) return;
    const onMessage = (e: MessageEvent<{ type?: string; action?: string; callId?: string; notificationType?: string; call?: string; title?: string }>) => {
      const d = e.data;
      if (d?.type === 'pm-call' && d.callId) {
        if (d.action === 'decline') { stopRinging(d.callId); void callsApi.decline(d.callId).catch(() => undefined); }
        else if (d.action === 'answer') { stopRinging(d.callId); nav(`/calls/${d.callId}`); }
      } else if (d?.type === 'pm-push' && d.notificationType === 'Call' && d.call) {
        ring({ callId: d.call, fromName: d.title?.replace(/ is calling$/, '') });
        e.ports[0]?.postMessage({ played: playRing() });
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [nav]);

  // While something rings: the ringtone every few seconds, a buzz and a flashing title when the person is elsewhere, and the system
  // notification when the tab is hidden; after 45 seconds it stops (the server files the missed call).
  const shown = useRef(new Set<string>());
  useEffect(() => {
    if (calls.length === 0) return;
    for (const c of calls) {
      if (!shown.current.has(c.callId)) {
        shown.current.add(c.callId);
        getAttention({ kind: 'urgent', silent: true });
        if (away()) void showSystemRing(c);
      }
    }
    playRing();
    const timer = window.setInterval(() => {
      for (const c of expire()) void closeSystemRing(c.callId);
      if (ringingCalls().length) playRing();
    }, RING_EVERY_MS);
    // Hidden after the ring began: the system notification takes over.
    const hidden = () => { if (away()) for (const c of ringingCalls()) void showSystemRing(c); };
    document.addEventListener('visibilitychange', hidden);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', hidden); };
  }, [calls]);

  // Already in that call (opened from a notification or another device): it does not ring here.
  useEffect(() => {
    const m = /\/calls\/([^/]+)/.exec(pathname);
    if (m) stopRinging(m[1]);
  }, [pathname]);

  const answer = (c: IncomingCall) => { stopRinging(c.callId); void closeSystemRing(c.callId); nav(`/calls/${c.callId}`); };
  const decline = (c: IncomingCall) => {
    stopRinging(c.callId); void closeSystemRing(c.callId);
    void callsApi.decline(c.callId).catch(() => undefined);
  };

  if (calls.length === 0) return null;
  return (
    <div className="call-incoming-stack" aria-live="assertive">
      {calls.map((c) => (
        <div key={c.callId} className="call-incoming" role="alertdialog" aria-labelledby={`ring-${c.callId}`} data-testid="incoming-call">
          <span className="call-incoming-ico" aria-hidden="true"><Icon name="video" size={20} /></span>
          <div className="call-incoming-text">
            <b id={`ring-${c.callId}`}>{c.fromName} is calling</b>
            <span>{c.title}</span>
          </div>
          <div className="call-incoming-actions">
            <button type="button" className="btn btn-sm call-incoming-decline" onClick={() => decline(c)} data-testid="incoming-call-decline">
              <Icon name="phoneOff" size={15} /><span>Decline</span>
            </button>
            <button type="button" className="btn btn-primary btn-sm call-incoming-answer" onClick={() => answer(c)} data-testid="incoming-call-answer" autoFocus>
              <Icon name="phone" size={15} /><span>Answer</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
