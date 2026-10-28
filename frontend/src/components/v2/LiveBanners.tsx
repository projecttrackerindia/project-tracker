import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { chatApi, notificationApi } from '../../api/endpoints';
import type { AppNotification } from '../../api/types';
import { CHECK_NOTIFICATIONS } from '../../features/notifications/events';
import { isRingNotice } from '../../features/calls/incomingCalls';
import { useAuth } from '../../stores/auth';
import { spring } from '../../lib/motion';
import { Icon } from '../Icon';
import { liveBannersOn } from './liveBannersPref';
import { toast } from '../../stores/ui';
import { playCue } from '../../lib/attention';
import { announce } from '../../features/notifications/centre/announce';
import { CATEGORY_META, categoryOf, conversationOf, iconOf } from '../../features/notifications/centre/model';
import { mayBanner, maySound } from '../../features/notifications/centre/prefs';
import { isViewing } from '../../features/notifications/centre/readSync';
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
        const all = page.items.filter((n) => !seen.current.has(n.id) && !isRingNotice(n) && Date.parse(n.createdAt) > since.current - 2000);
        all.forEach((n) => seen.current.add(n.id));
        // About the conversation open in front of them: no banner and no sound - those messages are read (the open chat tells the server).
        const arrived = all.filter((n) => !isViewing(n.link));
        // Each new one is announced once with its own sound (unless muted here); reminders keep their own alert card, so no banner for them.
        arrived.forEach((n) => { if (!SKIP.has(n.type)) announce(n); });
        const fresh = arrived.filter((n) => !SKIP.has(n.type) && mayBanner(categoryOf(n)));
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
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const left = useRef(HIDE_MS);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const cat = categoryOf(n);
  const meta = CATEGORY_META[cat];
  const conv = conversationOf(n.link);
  const canReply = cat === 'messages' && (!!conv || (n.actions ?? []).includes('reply'));
  useEffect(() => {
    if (hover || replying) return;
    const started = Date.now();
    const t = window.setTimeout(() => closeRef.current(), left.current);
    return () => { window.clearTimeout(t); left.current = Math.max(800, left.current - (Date.now() - started)); };
  }, [hover, replying]);
  const open = () => { onClose(); void notificationApi.read(n.id).catch(() => undefined); if (n.link) nav(n.link); };
  const send = async (e: FormEvent) => {
    e.preventDefault(); e.stopPropagation();
    const t = text.trim(); if (!t) return;
    try {
      if (conv) await chatApi.send(conv, t); else await notificationApi.act(n.id, 'reply', { text: t });
      await notificationApi.read(n.id).catch(() => undefined);
      if (maySound('messages')) playCue('sent');
      onClose();
    } catch { toast('Could not send your reply.', 'error'); }
  };
  return (
    <motion.div className="v2-live-card ncx-banner" role="status" layout={!still} data-cat={cat}
      initial={still ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.98 }} animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={still ? { opacity: 0 } : { opacity: 0, x: 40, transition: { duration: 0.18 } }} transition={still ? { duration: 0 } : spring.snappy}
      drag={still ? false : 'x'} dragConstraints={{ left: 0, right: 0 }} dragElastic={0.6}
      onDragEnd={(_e, info) => { if (Math.abs(info.offset.x) > 80) onClose(); }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('button, input, form')) open(); }}>
      <span className={`ncx-ico ${meta.tint}`} aria-hidden="true"><Icon name={iconOf(n)} size={15} /></span>
      <div className="ncx-banner-main">
        <span className="ncx-row1"><b>{n.title}</b><time>now</time></span>
        {n.body && <span className="ncx-text">{n.body}</span>}
        {canReply && !replying && (
          <div className="ncx-quick">
            <button type="button" className="ncx-btn" onClick={() => setReplying(true)}><Icon name="send" size={12} /> Reply</button>
            <button type="button" className="ncx-btn ghost" onClick={open}>Open chat</button>
          </div>
        )}
        {replying && (
          <form className="ncx-reply" onSubmit={(e) => void send(e)}>
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" aria-label="Reply" maxLength={4000}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setReplying(false); } }} />
            <button type="submit" className="ncx-send" aria-label="Send reply" disabled={!text.trim()}><Icon name="arrowUp" size={13} /></button>
          </form>
        )}
      </div>
      <button type="button" className="v2-live-x" aria-label="Dismiss" onClick={onClose}><Icon name="close" size={13} /></button>
    </motion.div>
  );
}
