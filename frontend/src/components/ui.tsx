import { createContext, forwardRef, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useSheetDrag } from './Sheet';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import type { Priority, ProjectHealth, ProjectStatus, ProjectType, Role, StageDisplayStatus, StatusCategory } from '../api/types';
import { ApiError } from '../api/client';
import { clamp, initials, labelize } from '../lib/format';
import { useUi } from '../stores/ui';
import { usePriorities } from '../features/priorities/usePriorities';
import { projectTypeLabel } from '../lib/workLabels';
import { Icon, type IconName } from './Icon';

// ------------------------------------------------------------------ badges
const PRIORITY_CLASS: Record<Priority, string> = { Critical: 'badge-critical', High: 'badge-high', Medium: 'badge-medium', Low: 'badge-low' };

/** The priority as this workspace names and colours it (standard look until someone customises it). */
export function PriorityBadge({ priority }: { priority: Priority }) {
  const { info } = usePriorities();
  const i = info(priority);
  if (!i.isCustom) return <span className={`badge ${PRIORITY_CLASS[priority] ?? 'badge-neutral'}`}><span className="dot" />{i.name}</span>;
  const c = i.color;
  return (
    <span className="badge badge-custom" style={{ '--c': c } as CSSProperties}>
      <span className="dot" />{i.name}
    </span>
  );
}

/** <option>s for the four levels, labelled with this workspace's names; the value is always the level. */
export function PriorityOptions() {
  const { list } = usePriorities();
  return <>{list.map((p) => <option key={p.level} value={p.level}>{p.name}</option>)}</>;
}

const CATEGORY_CLASS: Record<StatusCategory, string> = {
  Todo: 'badge-neutral', Active: 'badge-info', Done: 'badge-success', Cancelled: 'badge-neutral',
};
export const TaskStatusBadge = ({ name, category }: { name: string; category: StatusCategory }) => (
  <span className={`badge ${CATEGORY_CLASS[category]}`}><span className="dot" />{name}</span>
);

const PROJECT_STATUS_CLASS: Record<ProjectStatus, string> = {
  Planning: 'badge-neutral', Active: 'badge-info', OnHold: 'badge-warning', Completed: 'badge-success', Cancelled: 'badge-neutral', Archived: 'badge-neutral',
};
export const ProjectStatusBadge = ({ status }: { status: ProjectStatus }) => (
  <span className={`badge ${PROJECT_STATUS_CLASS[status]}`}><span className="dot" />{labelize(status)}</span>
);

/** What the project is for (new project, change request, enhancement ...). */
export const ProjectTypeBadge = ({ type }: { type: ProjectType | null | undefined }) => (
  <span className="badge badge-neutral" title="Project type">{projectTypeLabel(type)}</span>
);

const HEALTH_CLASS: Record<ProjectHealth, string> = {
  OnTrack: 'badge-success', AtRisk: 'badge-warning', Delayed: 'badge-danger', Completed: 'badge-info', Cancelled: 'badge-neutral', Archived: 'badge-neutral',
};
export const HealthBadge = ({ health }: { health: ProjectHealth }) => (
  <span className={`badge ${HEALTH_CLASS[health]}`}><span className="dot" />{labelize(health)}</span>
);

const STAGE_CLASS: Record<StageDisplayStatus, string> = {
  Pending: 'badge-neutral', InProgress: 'badge-info', Completed: 'badge-success', Delayed: 'badge-danger', Locked: 'badge-neutral',
};
export const StageBadge = ({ status }: { status: StageDisplayStatus }) => (
  <span className={`badge ${STAGE_CLASS[status]}`}>{status === 'Locked' ? <Icon name="lock" size={11} /> : <span className="dot" />}{labelize(status)}</span>
);

const ROLE_CLASS: Record<Role, string> = { Owner: 'badge-purple', Admin: 'badge-info', Manager: 'badge-success', Member: 'badge-neutral', Guest: 'badge-warning' };
export const RoleBadge = ({ role }: { role: Role }) => <span className={`badge ${ROLE_CLASS[role]}`}>{role}</span>;

export const Badge = ({ tone = 'neutral', children }: { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'purple'; children: ReactNode }) => (
  <span className={`badge badge-${tone}`}>{children}</span>
);

// ------------------------------------------------------------------ small pieces
/** The share of a project's tasks being worked on right now (In progress), so work under way shows even before anything is finished. */
export const activeShare = (s: { total: number; done: number; inProgress: number; cancelled: number }) => {
  const denominator = s.total - s.cancelled;
  return denominator <= 0 ? 0 : Math.min(100 - Math.round((s.done * 100) / denominator), Math.round((s.inProgress * 100) / denominator));
};

/** `value` is what is done; `active` (optional) is the extra share being worked on, drawn lighter after it. */
export function Progress({ value, tone = 'auto', large, active = 0 }: { value: number; tone?: 'auto' | '' | 'green' | 'amber' | 'red'; large?: boolean; active?: number }) {
  const p = clamp(Math.round(value), 0, 100);
  const a = clamp(Math.round(active), 0, 100 - p);
  const cls = tone === 'auto' ? (p >= 75 ? 'green' : p >= 40 ? '' : 'red') : tone;
  return (
    <div className={`progress ${large ? 'progress-lg' : ''}`} role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}
      aria-valuetext={a > 0 ? `${p}% done, ${a}% in progress` : `${p}% done`} title={a > 0 ? `${p}% done · ${a}% in progress` : undefined}>
      {a > 0 && <div className="progress-active" style={{ left: `${p}%`, width: `${a}%` }} />}
      <div className={`progress-bar ${cls}`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** userId -> the photo as an object URL, and when it was fetched (so a photo someone changed shows up again after a while). */
const avatarUrlCache = new Map<string, { url: string; at: number }>();
/** People we found to have no photo, so a card full of the same person does not ask the server again and again. */
const avatarMissing = new Map<string, number>();
const avatarPending = new Map<string, Promise<string | null>>();
const AVATAR_TTL_MS = 10 * 60_000;
const AVATAR_MISSING_TTL_MS = 60_000;

let avatarEpoch = 0;
const avatarListeners = new Set<() => void>();
const subscribeAvatars = (fn: () => void) => { avatarListeners.add(fn); return () => { avatarListeners.delete(fn); }; };
const getAvatarEpoch = () => avatarEpoch;

/** Call after a photo is uploaded or removed so every <Avatar> for that person re-fetches instead of showing the stale cached one. */
export function invalidateAvatarCache(userId: string) {
  const hit = avatarUrlCache.get(userId);
  if (hit) { URL.revokeObjectURL(hit.url); avatarUrlCache.delete(userId); }
  avatarMissing.delete(userId);
  avatarEpoch += 1;
  avatarListeners.forEach((fn) => fn());
}

/** The photo's object URL, or null when the person has none. One request per person at a time, shared by every caller. */
function loadAvatar(userId: string): Promise<string | null> {
  const hit = avatarUrlCache.get(userId);
  if (hit && Date.now() - hit.at < AVATAR_TTL_MS) return Promise.resolve(hit.url);
  const missedAt = avatarMissing.get(userId);
  if (missedAt !== undefined && Date.now() - missedAt < AVATAR_MISSING_TTL_MS) return Promise.resolve(null);
  let pending = avatarPending.get(userId);
  if (!pending) {
    pending = import('../api/endpoints')
      .then(({ workspaceApi }) => workspaceApi.memberAvatarUrl(userId))
      .then((url) => { avatarUrlCache.set(userId, { url, at: Date.now() }); avatarMissing.delete(userId); return url as string | null; })
      .catch(() => { avatarMissing.set(userId, Date.now()); return hit?.url ?? null; })
      .finally(() => { avatarPending.delete(userId); });
    avatarPending.set(userId, pending);
  }
  return pending;
}

/**
 * A person's photo URL if they have one. Pass `hasAvatar` when the list you have says so (false skips the request); when it is unknown
 * (most cards only know a person's id and name) the photo is looked up once and cached - a 404 just means "no photo, show initials".
 */
export function useAvatarUrl(userId?: string, hasAvatar?: boolean) {
  const epoch = useSyncExternalStore(subscribeAvatars, getAvatarEpoch);
  const [url, setUrl] = useState<string | null>(() => (userId ? avatarUrlCache.get(userId)?.url : undefined) ?? null);
  useEffect(() => {
    if (!userId || hasAvatar === false) { setUrl(null); return; }
    let cancelled = false;
    void loadAvatar(userId).then((u) => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [userId, hasAvatar, epoch]);
  return url;
}

/** A person's photo if they have one, initials otherwise. */
export const Avatar = ({ name, size, userId, hasAvatar }: { name?: string | null; size?: 'sm' | 'lg'; userId?: string; hasAvatar?: boolean }) => {
  const url = useAvatarUrl(userId, hasAvatar);
  if (url) return <span className={`avatar avatar-photo ${size ?? ''}`} title={name ?? undefined}><img src={url} alt="" /></span>;
  return <span className={`avatar ${size ?? ''}`} title={name ?? undefined}>{initials(name)}</span>;
};

export const Spinner = () => <span className="spinner" role="status" aria-label="Loading" />;
export const PageLoader = () => <div className="page-loader"><Spinner /></div>;

export function EmptyState({ icon = 'inbox', title, text, action }: { icon?: IconName; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-ico"><Icon name={icon} /></div>
      <h4>{title}</h4>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message = error instanceof ApiError ? error.message : 'Something went wrong.';
  return (
    <div className="empty">
      <div className="empty-ico" style={{ color: 'var(--danger)' }}><Icon name="alert" /></div>
      <h4>Could not load this page</h4>
      <p>{message}</p>
      {retry && <button className="btn btn-ghost" onClick={retry}><Icon name="refresh" /> Try again</button>}
    </div>
  );
}

/**
 * Set by a hub page (People, Insights, Workspace settings, My account) around the section it shows: the section's own PageHead then
 * renders as a section heading under the hub's title instead of as a second page title.
 */
const EmbeddedContext = createContext(false);
export const Embedded = ({ children }: { children: ReactNode }) => <EmbeddedContext.Provider value>{children}</EmbeddedContext.Provider>;

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  const embedded = useContext(EmbeddedContext);
  if (embedded) return (
    <div className="section-head">
      <div><h2 className="hub-section-title">{title}</h2>{sub && <p className="page-sub">{sub}</p>}</div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
  return (
    <div className="page-head">
      <div><h1 className="page-title">{title}</h1>{sub && <p className="page-sub">{sub}</p>}</div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export interface SectionLink { to: string; label: string; icon?: IconName; end?: boolean; badge?: number }

/** Tabs that are links: each tab is its own address, so it can be bookmarked, shared and reached with Back. */
export function RouteTabs({ tabs, label }: { tabs: SectionLink[]; label: string }) {
  return (
    <nav className="tabs route-tabs" aria-label={label}>
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end ?? true} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>
          {t.icon && <Icon name={t.icon} />}{t.label}{!!t.badge && <span className="tab-badge">{t.badge}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

/** A settings-style page: a title, a list of sections down the left (grouped), and the chosen section on the right. */
export function SectionLayout({ title, sub, groups, children }: { title: string; sub?: string; groups: { title?: string; items: SectionLink[]; collapsed?: boolean }[]; children: ReactNode }) {
  const { pathname } = useLocation();
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  return (
    <>
      <PageHead title={title} sub={sub} />
      <div className="section-layout">
        <nav className="section-nav" aria-label={`${title} sections`}>
          {groups.filter((g) => g.items.length).map((g, i) => {
            // Advanced groups stay folded until they are needed: opened by a click, or because the page being shown is inside one.
            const holdsCurrent = g.items.some((t) => pathname === t.to || pathname.startsWith(`${t.to}/`));
            const open = !g.collapsed || holdsCurrent || !!opened[g.title ?? i];
            return (
            <div className="section-nav-group" key={g.title ?? i}>
              {g.title && (g.collapsed
                ? <button type="button" className="section-nav-title fold" aria-expanded={open} onClick={() => setOpened((o) => ({ ...o, [g.title ?? i]: !open }))}>{g.title}<Icon name="chevronD" size={13} /></button>
                : <div className="section-nav-title">{g.title}</div>)}
              {open && g.items.map((t) => (
                <NavLink key={t.to} to={t.to} end={t.end ?? true} className={({ isActive }) => `section-nav-item ${isActive ? 'active' : ''}`}>
                  {t.icon && <Icon name={t.icon} size={16} />}<span>{t.label}</span>
                </NavLink>
              ))}
            </div>
            );
          })}
        </nav>
        <div className="section-body"><Embedded>{children}</Embedded></div>
      </div>
    </>
  );
}

export function StatCard({ icon, tone, value, label, foot }: { icon?: IconName; tone?: string; value: ReactNode; label: string; foot?: ReactNode }) {
  return (
    <div className="stat-card">
      {icon && <div className="stat-top"><div className={`stat-icon ${tone ?? 'blue'}`}><Icon name={icon} /></div></div>}
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

export function Pager({ page, totalPages, totalItems, onPage }: { page: number; totalPages: number; totalItems: number; onPage: (p: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="pager">
      <span>Page {page} of {totalPages} · {totalItems.toLocaleString()} items</span>
      <div className="row">
        <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><Icon name="chevronL" /> Prev</button>
        <button className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>Next <Icon name="chevronR" /></button>
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; icon?: IconName; badge?: number }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon && <Icon name={t.icon} />}{t.label}{!!t.badge && <span className="tab-badge" aria-label={`${t.badge} open`}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return <span className="label-chip" style={{ background: `${color}26`, color, borderColor: `${color}40` }}>{name}</span>;
}

// ------------------------------------------------------------------ forms
export function Field({ label, required, error, hint, full, children }: {
  label?: string; required?: boolean; error?: string; hint?: string; full?: boolean; children: ReactNode;
}) {
  return (
    <div className={`field ${full ? 'full' : ''} ${error ? 'invalid' : ''}`}>
      {label && <label>{label}{required && <span className="req">*</span>}</label>}
      {children}
      {error ? <div className="field-error" role="alert">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

/** A password `.input` with a show/hide toggle (for the plain, label-above field style; see `PasswordField` in auth/AuthFields for the icon-in-box login style). */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function PasswordInput({ className, ...rest }, ref) {
    const [revealed, setRevealed] = useState(false);
    return (
      <div className="password-box">
        <input ref={ref} className={`input ${className ?? ''}`} type={revealed ? 'text' : 'password'} {...rest} />
        <button type="button" className="password-toggle" tabIndex={-1} aria-pressed={revealed}
          aria-label={revealed ? 'Hide password' : 'Show password'} onClick={() => setRevealed((v) => !v)}>
          <Icon name={revealed ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </div>
    );
  },
);

/** Maps server-reported field errors onto react-hook-form; returns the general message for anything else. */
export function applyServerErrors(err: unknown, setError: (name: any, e: { message: string }) => void, fields: string[]): string | null {
  if (!(err instanceof ApiError)) return 'Something went wrong. Please try again.';
  let general: string | null = null;
  for (const e of err.errors) {
    if (e.field && fields.includes(e.field)) setError(e.field, { message: e.message });
    else general ??= e.message;
  }
  return general;
}

// ------------------------------------------------------------------ modal
export function Modal({ title, subtitle, onClose, children, footer, size, onSubmit }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
  size?: 'sm' | 'lg' | 'xl'; onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useSheetDrag(() => ref.current, onClose);   // on a phone a dialog is a sheet: drag its handle down to dismiss it

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    const root = ref.current;
    const focusables = () => Array.from(root?.querySelectorAll<HTMLElement>('input,select:not(.ss-native),textarea,button,[href],[tabindex]:not([tabindex="-1"])') ?? [])
      .filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
    (root?.querySelector<HTMLElement>('input:not([type=hidden]),.ss-trigger,textarea') ?? focusables()[1])?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inner = (
    <>
      <div className="modal-head">
        <div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
        <button className="btn-icon" type="button" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </>
  );

  return createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className={`modal ${size ?? ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-grab" {...drag}><i aria-hidden="true" /></div>
        {onSubmit ? <form onSubmit={onSubmit} noValidate style={{ display: 'contents' }}>{inner}</form> : inner}
      </div>
    </div>,
    document.body,
  );
}

export function SubmitButton({ busy, children }: { busy?: boolean; children: ReactNode }) {
  return <button className="btn btn-primary" type="submit" disabled={busy}>{busy && <span className="spinner" />}{children}</button>;
}

// ------------------------------------------------------------------ global roots
export function ToastRoot() {
  const toasts = useUi((s) => s.toasts);
  const icon = { success: 'checkCircle', error: 'xCircle', warning: 'alert', info: 'info' } as const;
  return (
    <div className="toast-root" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type}`}>
          <span className="toast-ico"><Icon name={icon[t.type]} /></span><span>{t.message}</span>
          {t.action && <button className="toast-action" onClick={() => { t.action!.onClick(); useUi.getState().dismissToast(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}

export function ConfirmRoot() {
  const c = useUi((s) => s.confirm);
  if (!c) return null;
  if (c.alertOnly) return (
    <Modal size="sm" title={c.title} onClose={() => c.resolve(true)}
      footer={<button className="btn btn-primary" onClick={() => c.resolve(true)} autoFocus>{c.confirmText}</button>}>
      <div className="form-warn" role="alert" style={{ margin: 0, display: 'flex', alignItems: 'flex-start', gap: 9 }}><span style={{ flexShrink: 0, marginTop: 2 }}><Icon name="alert" size={15} /></span><span>{c.message}</span></div>
    </Modal>
  );
  return (
    <Modal size="sm" title={c.title} subtitle={c.danger ? 'This action cannot be undone.' : undefined} onClose={() => c.resolve(false)}
      footer={<>
        <button className="btn btn-ghost" onClick={() => c.resolve(false)}>Cancel</button>
        <button className={`btn ${c.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => c.resolve(true)} autoFocus>{c.confirmText}</button>
      </>}>
      <p style={{ fontSize: 13.5, color: 'var(--text-2)', lineHeight: 1.6 }}>{c.message}</p>
    </Modal>
  );
}
