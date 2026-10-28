import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { chatApi, workspaceApi } from '../../api/endpoints';
import { ApiError, put } from '../../api/client';
import type { Conversation, MemberProfile } from '../../api/types';
import { ErrorState, PageLoader } from '../../components/ui';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { formatDate, initials } from '../../lib/format';
import { useIsMobile } from '../../lib/mobile';
import { PALETTES, PERSON_THEMES, avatarBg, meshOf, themeOf, type PersonThemeId } from '../../lib/personTheme';
import { usePresence } from '../chat/Presence';
import { chatKeys } from '../chat/chatStore';
import { StartCallButton } from '../calls/StartCall';
import './profileCard.css';

const ROLE_LABEL: Record<string, string> = { Owner: 'Owner', Admin: 'Admin', Manager: 'Manager', Member: 'Member', Guest: 'Guest' };

// Where the person last tapped, so the card can grow out of the avatar they tapped.
let lastTap: { x: number; y: number } | null = null;
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { lastTap = { x: e.clientX, y: e.clientY }; }, true);

/**
 * Someone's profile card, drawn as a compact Apple-style card: a mesh banner in their theme, their face over its corner, their team on a
 * glass pill, three work stats, quieter details (email, who they report to, joined, presence) and Message. On a phone it is a bottom
 * sheet holding the same card. A person can choose their own card theme here; everyone else sees it. Editing anything else only ever
 * happens on the person's own Settings page.
 */
export function MemberProfileModal({ userId: firstId, onClose }: { userId: string; onClose: () => void }) {
  const [userId, setUserId] = useState(firstId);
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const phone = useIsMobile();
  const reduce = useReducedMotion();
  const q = useQuery({ queryKey: ['member-profile', userId], queryFn: () => workspaceApi.memberProfile(userId), staleTime: 30_000 });
  const status = usePresence(userId, 'offline');
  const origin = useRef(lastTap);
  const [closing, setClosing] = useState(false);
  const close = () => { if (reduce) onClose(); else setClosing(true); };

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const message = async () => {
    try {
      const c = await chatApi.openDirect(userId);
      onClose();
      navigate(`/messages/${c.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Could not open the chat.', 'error');
    }
  };

  const p = q.data;
  const theme = themeOf(userId, p?.theme);
  const direct = wid ? (queryClient.getQueryData<Conversation[]>(chatKeys.conversations(wid)) ?? []).find((c) => c.type === 'Direct' && c.otherUserId === userId) : undefined;

  // Spring in from the tapped point (desktop); slide up (phone).
  const from = origin.current && !phone ? { x: origin.current.x - innerWidth / 2, y: origin.current.y - innerHeight / 2 } : { x: 0, y: 0 };
  const hidden = phone ? { y: '100%' } : { opacity: 0, scale: .4, ...from };
  const shown = phone ? { y: 0 } : { opacity: 1, scale: 1, x: 0, y: 0 };

  return createPortal(
    <div className={`pcard-overlay${phone ? ' pcard-sheet' : ''}`} onClick={close} data-testid="profile-overlay">
      <motion.div className="pcard-backdrop" initial={{ opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }} transition={{ duration: reduce ? 0 : .2 }} />
      <motion.div className={`pcard t-${theme}`} role="dialog" aria-modal="true" aria-label={p ? `${p.displayName}'s profile` : 'Profile'}
        data-testid="profile-card" data-theme-id={theme}
        onClick={(e) => e.stopPropagation()}
        initial={reduce ? false : hidden} animate={closing ? hidden : shown}
        transition={reduce ? { duration: 0 } : closing ? { duration: .18, ease: 'easeIn' } : { type: 'spring', stiffness: 420, damping: 32, mass: .8 }}
        onAnimationComplete={() => { if (closing) onClose(); }}>
        {phone && <span className="pcard-grabber" aria-hidden="true" />}
        <button type="button" className="pcard-x" onClick={close} aria-label="Close profile"><Icon name="close" size={14} /></button>
        {q.isLoading && <div className="pcard-loading"><PageLoader /></div>}
        {q.isError && <ErrorState error={q.error} />}
        {p && <CardBody p={p} theme={theme} status={status} direct={direct} onMessage={message} onOpen={setUserId}
          onSettings={() => { onClose(); navigate('/account'); }} />}
      </motion.div>
    </div>,
    document.body,
  );
}

function CardBody({ p, theme, status, direct, onMessage, onOpen, onSettings }: {
  p: MemberProfile; theme: PersonThemeId; status: string; direct?: Conversation; onMessage: () => void; onOpen: (id: string) => void; onSettings: () => void;
}) {
  const banner = useRef<HTMLDivElement>(null);
  const pill = p.teams[0]?.name ?? p.jobRole;
  const presence = status === 'active' ? 'Active now' : status === 'away' ? 'Away' : 'Not active right now';
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.email); toast('Email copied.', 'success'); } catch { toast('Could not copy the email.', 'error'); }
  };
  // A light parallax and shine that follow the pointer over the banner.
  const move = (e: React.PointerEvent) => {
    const el = banner.current; if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', `${((e.clientX - r.left) / r.width - .5) * 10}px`);
    el.style.setProperty('--py', `${((e.clientY - r.top) / r.height - .5) * 8}px`);
    el.style.setProperty('--sx', `${((e.clientX - r.left) / r.width) * 100}%`);
  };
  const leave = () => { const el = banner.current; el?.style.removeProperty('--px'); el?.style.removeProperty('--py'); el?.style.removeProperty('--sx'); };

  return (
    <>
      <div className="pcard-banner" ref={banner} onPointerMove={move} onPointerLeave={leave} data-testid="profile-banner">
        <div className="pcard-mesh" style={{ background: meshOf(theme) } as CSSProperties} />
        <div className="pcard-shine" aria-hidden="true" />
        {pill && <span className="pcard-pill" data-testid="profile-pill"><Icon name={p.teams.length ? 'users' : 'tag'} size={12} />{pill}</span>}
      </div>
      <div className="pcard-av-ring" data-testid="profile-avatar">
        <Face userId={p.userId} hasAvatar={p.hasAvatar} className="pcard-av" style={{ background: avatarBg(theme) }} text={initials(p.displayName)} />
        {status === 'active' && <i className="pcard-dot" aria-hidden="true" />}
      </div>
      <div className="pcard-id">
        <div className="pcard-name">
          <h3>{p.displayName}</h3>
          <span>{p.jobRole ?? ROLE_LABEL[p.role]}{p.teams.length > 1 ? ` · ${p.teams.slice(1).map((t) => t.name).join(', ')}` : ''}</span>
        </div>
        {p.email && <button type="button" className="pcard-round" onClick={copy} aria-label="Copy email" title="Copy email"><Icon name="copy" size={16} /></button>}
      </div>

      <div className="pcard-stats" data-testid="profile-stats" title={`${p.doneTotal} done in total`}>
        <div><span className="pcard-ico i-open"><Icon name="clock" size={13} /></span><b>{p.open}</b><small>Open</small></div>
        <div className={p.overdue > 0 ? 'late' : ''}><span className="pcard-ico i-late"><Icon name="flag" size={13} /></span><b>{p.overdue}</b><small>Overdue</small></div>
        <div><span className="pcard-ico i-done"><Icon name="check" size={13} /></span><b>{p.doneLast30Days}</b><small>Done 30d</small></div>
      </div>
      <p className="pcard-total">{p.doneTotal} done in total</p>

      <ul className="pcard-lines">
        <li><i className={`pcard-presence ${status}`} aria-hidden="true" />{presence}</li>
        {p.email && <li><Icon name="mail" size={13} /><a href={`mailto:${p.email}`}>{p.email}</a></li>}
        {p.reportsTo && <li><Icon name="user" size={13} /><span>Reports to <button type="button" className="pcard-link" onClick={() => onOpen(p.reportsTo!.id)}>{p.reportsTo.name}</button></span></li>}
        <li><Icon name="calendar" size={13} /><span>Joined {formatDate(p.joinedAt)}</span></li>
        {!!p.certificationBadges?.length && <li className="pcard-badges">{p.certificationBadges.map((c, i) => <span key={i} className="badge badge-neutral" title={`${c.issuer} · ${c.verificationStatus}${c.expiresOn ? ` · Expires ${c.expiresOn}` : ''}`}>{c.name}</span>)}</li>}
      </ul>

      {p.isMe && <ThemePicker p={p} current={theme} />}

      <div className="pcard-actions">
        {p.isMe
          ? <button type="button" className="pcard-primary" onClick={onSettings}><Icon name="edit" size={15} /> Edit in Settings</button>
          : p.canMessage && <button type="button" className="pcard-primary" onClick={onMessage}><Icon name="message" size={15} /> Message</button>}
        {!p.isMe && direct && <StartCallButton conversationId={direct.id} label={`Call ${p.displayName}`} compact className="pcard-round" />}
      </div>
    </>
  );
}

/** Only on my own card: choose my card theme; saved with my account and shown to everyone who opens my card. */
function ThemePicker({ p, current }: { p: MemberProfile; current: PersonThemeId }) {
  const pick = async (t: PersonThemeId) => {
    const before = p.theme ?? null;
    queryClient.setQueryData<MemberProfile>(['member-profile', p.userId], (old) => old && { ...old, theme: t });
    try { await put('/me/ui/profile', { value: { theme: t } }); }
    catch { queryClient.setQueryData<MemberProfile>(['member-profile', p.userId], (old) => old && { ...old, theme: before }); toast('Could not save your card theme.', 'error'); }
  };
  return (
    <div className="pcard-theme" role="radiogroup" aria-label="Theme" data-testid="profile-theme">
      <span>Theme</span>
      <div>
        {PERSON_THEMES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={t === current} aria-label={PALETTES[t].label} title={PALETTES[t].label}
            className={`pcard-swatch${t === current ? ' on' : ''}`} style={{ background: avatarBg(t) }} onClick={() => void pick(t)} />
        ))}
      </div>
    </div>
  );
}
