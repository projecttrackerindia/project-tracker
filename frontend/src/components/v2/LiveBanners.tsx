import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { notificationApi } from '../../api/endpoints';
import type { AppNotification } from '../../api/types';
import { CHECK_NOTIFICATIONS } from '../../features/notifications/events';
import { isRingNotice } from '../../features/calls/incomingCalls';
import { useAuth } from '../../stores/auth';
import { spring } from '../../lib/motion';
import { Icon } from '../Icon';
import { liveBannersOn } from './liveBannersPref';
import './v2.css';

const MAX = 3;
const HIDE_MS = 6000;
/** Reminders have their own alert (ReminderAlerts), and a ringing call its own card (IncomingCallHost); they do not get a second banner. */
const SKIP = new Set(['Reminder', 'Nudge', 'DueSoon', 'Overdue']);

/**
 * Live banners: a glass toast in the top-right corner for each new notification while the app is open (at most three, each hiding after six
 * seconds unless the pointer rests on it, one action: Open). Listens to the same signal the live connection fires when a notification is
 * created for the signed-in person (CHECK_NOTIFICATIONS), then reads what is new; nothing older than this page's opening is replayed.
 */
export function LiveBanners() {
  const wid = useAuth((s) => s.ctx?.current?.id);
  const admin = useAuth((s) => !!s.ctx?.user.isPlatformAdmin);
  const [items, setItems] = useState<AppNotification[]>([]);
  const since = useRef(Date.now());
  const seen = useRef(new Set<string>());
  const qc = useQueryClient();

  useEffect(() => {
    if (!wid || admin) return;
    since.current = Date.now();
    seen.current = new Set();
    setItems([]);
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try {
        const page = await notificationApi.list(1, true);
        const fresh = page.items.filter((n) => !seen.current.has(n.id) && !SKIP.has(n.type) && !isRingNotice(n) && Date.parse(n.createdAt) > since.current - 2000);
        fresh.forEach((n) => seen.current.add(n.id));
        if (fresh.length && liveBannersOn()) {
          setItems((cur) => [...fresh.reverse(), ...cur].slice(0, MAX));
          void qc.invalidateQueries({ queryKey: [wid, 'inbox'] });
        }
      } catch { /* offline: the next signal tries again */ }
      finally { running = false; }
    };
    window.addEventListener(CHECK_NOTIFICATIONS, check);
    return () => window.removeEventListener(CHECK_NOTIFICATIONS, check);
  }, [wid, admin, qc]);

  const dismiss = (id: string) => setItems((cur) => cur.filter((n) => n.id !== id));
  return (
    <div className="v2-live" aria-live="polite" aria-label="New notifications">
      <AnimatePresence initial={false}>
        {items.map((n) => <Banner key={n.id} n={n} onClose={() => dismiss(n.id)} />)}
      </AnimatePresence>
    </div>
  );
}

function Banner({ n, onClose }: { n: AppNotification; onClose: () => void }) {
  const nav = useNavigate();
  const still = useReducedMotion();
  const [hover, setHover] = useState(false);
  const left = useRef(HIDE_MS);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (hover) return;
    const started = Date.now();
    const t = window.setTimeout(() => closeRef.current(), left.current);
    return () => { window.clearTimeout(t); left.current = Math.max(800, left.current - (Date.now() - started)); };
  }, [hover]);
  return (
    <motion.div className="v2-live-card" role="status" layout={!still}
      initial={still ? { opacity: 0 } : { opacity: 0, x: 32, scale: 0.98 }} animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={still ? { opacity: 0 } : { opacity: 0, x: 32, transition: { duration: 0.18 } }} transition={still ? { duration: 0 } : spring.snappy}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
      <span className="v2-live-ico" aria-hidden="true"><Icon name="bell" size={15} /></span>
      <div className="v2-live-text"><b>{n.title}</b>{n.body && <span>{n.body}</span>}</div>
      {n.link && <button type="button" className="btn btn-primary btn-sm" onClick={() => { onClose(); nav(n.link!); }}>Open</button>}
      <button type="button" className="v2-live-x" aria-label="Dismiss" onClick={onClose}><Icon name="close" size={13} /></button>
    </motion.div>
  );
}
