import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, Modal, PageHead, PageLoader } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { GROUP_INFO, SETTINGS_GROUPS, useWorkspaceSections, type SectionDef } from './sections';
import { SETTINGS_INDEX, searchSettings, settingHref, visibleSettings, type SettingEntry } from './settingsIndex';
import { settingsApi, type ImpactRequest, type SettingChange, type SettingImpact, type SetupCheck } from './settingsApi';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const useIsAdmin = () => useAuth((s) => s.ctx?.current?.role === 'Owner' || s.ctx?.current?.role === 'Admin');
const useCanSeeHistory = () => useAuth((s) => {
  const c = s.ctx?.current;
  return !!c && (c.role === 'Owner' || c.role === 'Admin' || (c.permissions ?? []).includes('audit.view'));
});

// ================================================================== search

/** Search across every setting the person may open: picking one jumps straight to the switch. */
export function SettingsSearch({ autoFocus, compact }: { autoFocus?: boolean; compact?: boolean }) {
  const sections = useWorkspaceSections();
  const entries = useMemo(() => visibleSettings(sections, sections.length > 0), [sections]);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const listId = useId();
  const results = useMemo(() => searchSettings(q, entries), [q, entries]);
  const sectionOf = (e: SettingEntry) => sections.find((s) => s.id === e.section);
  const pick = (e: SettingEntry | undefined) => {
    if (!e) return;
    setQ(''); setOpen(false);
    nav(settingHref(e));
  };
  useEffect(() => setActive(0), [q]);
  return (
    <div className={`set-search ${compact ? 'compact' : ''}`} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Icon name="search" size={15} />
      <input className="input" type="search" value={q} autoFocus={autoFocus} placeholder={compact ? 'Find a setting' : 'Find a setting: “MFA”, “logo”, “Slack”, “retention”…'}
        aria-label="Find a setting" role="combobox" aria-expanded={open && results.length > 0} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(results[active]); }
          else if (e.key === 'Escape') { setOpen(false); }
        }} />
      {open && q.trim().length >= 2 && (
        <div className="set-search-results" role="listbox" id={listId} aria-label="Settings found">
          {results.length === 0 ? <div className="set-search-empty">No setting matches “{q.trim()}”. Try another word, like “password” or “invoice”.</div>
            : results.map((r, i) => {
              const s = sectionOf(r);
              return (
                <button key={r.id} type="button" role="option" id={`${listId}-${i}`} aria-selected={i === active} className={`set-search-item ${i === active ? 'active' : ''}`}
                  onMouseMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                  <Icon name={s?.icon ?? (r.personal ? 'user' : 'settings')} size={15} />
                  <span className="set-search-main"><b>{r.label}</b><small>{r.personal ? r.hint : s ? `${s.group} → ${s.label}${r.hint ? ` · ${r.hint}` : ''}` : r.hint}</small></span>
                  {i === active && <Icon name="arrowRight" size={13} />}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}

/**
 * After a jump ("#s-security.requireMfa"), finds the setting on the page, brings it into view, flashes it and focuses its switch. Pages load
 * their data after they open, so it keeps looking for a few seconds. Rows carry `data-setting`; others are found by their heading.
 */
export function useSettingJump() {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    if (!hash.startsWith('#s-')) return;
    const id = decodeURIComponent(hash.slice(3));
    const entry = SETTINGS_INDEX.find((e) => e.id === id);
    const started = Date.now();
    let timer = 0;
    const byText = (text: string) => {
      const want = text.toLowerCase();
      const scope = document.querySelector('.section-body') ?? document.querySelector('main') ?? document.body;
      const nodes = Array.from(scope.querySelectorAll<HTMLElement>('h2, h3, h4, legend, label, b, .setting-info h4, .card-head h3'));
      const hit = nodes.find((n) => n.textContent?.trim().toLowerCase() === want) ?? nodes.find((n) => n.textContent?.toLowerCase().includes(want));
      return hit?.closest<HTMLElement>('.setting-row, .retention-row, .card, .field, label') ?? hit ?? null;
    };
    const look = () => {
      const el = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(id)}"]`) ?? (entry ? byText(entry.find ?? entry.label) : null);
      if (!el) { if (Date.now() - started < 5000) timer = window.setTimeout(look, 150); return; }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('setting-flash');
      window.setTimeout(() => el.classList.remove('setting-flash'), 2600);
      const control = el.querySelector<HTMLElement>('input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role=combobox], [role=switch], button:not([disabled])');
      control?.focus({ preventScroll: true });
    };
    timer = window.setTimeout(look, 60);
    return () => window.clearTimeout(timer);
  }, [hash, pathname]);
}

// ================================================================== who changed what

export function useSettingChanges(section: string) {
  const can = useCanSeeHistory();
  return useWsQuery(['settings', 'changes', section], () => settingsApi.changes(section), { enabled: can, staleTime: 30_000, retry: false });
}

function useUndo() {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (c: SettingChange) => {
    setBusy(c.auditId);
    try {
      const r = await settingsApi.undo(c.auditId, c.key);
      toast(r.message);
      // The page under the line reads the setting from its own query: refresh everything in this workspace.
      void invalidateWorkspace(wid);
    } catch (e) { toast(errText(e, 'Could not undo it.'), 'error'); }
    finally { setBusy(null); }
  };
  return { busy, run };
}

/** "Changed 2 days ago by Ravi: Off → On · Undo" under one setting. Nothing when it was never changed or the person may not see the history. */
export function LastChanged({ k, section }: { k: string; section: string }) {
  const q = useSettingChanges(section);
  const undo = useUndo();
  const c = q.data?.items?.find((i) => i.key === k);
  if (!c) return null;
  return (
    <div className="last-changed" data-testid={`last-changed-${k}`}>
      <Icon name="clock" size={12} />
      <span title={formatDateTime(c.at)}>{c.wasUndo ? 'Undone' : 'Changed'} {timeAgo(c.at)} by {c.byName ?? 'someone'}: {c.summary}</span>
      {c.canUndo && <button type="button" className="link-btn" disabled={undo.busy === c.auditId} title={c.undoTo ? `Put it back to ${c.undoTo}` : undefined}
        onClick={() => void undo.run(c)}>{undo.busy === c.auditId ? 'Undoing…' : 'Undo'}</button>}
    </div>
  );
}

/** Every setting on this page that was changed, newest first, with who changed it and undo for the last change. */
export function SectionHistory({ section, title = 'Recent changes here' }: { section: string; title?: string }) {
  const q = useSettingChanges(section);
  const undo = useUndo();
  const [open, setOpen] = useState(false);
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  const shown = open ? items : items.slice(0, 3);
  return (
    <section className="card set-history" aria-label={title}>
      <div className="card-head"><div><h3><Icon name="clock" size={15} /> {title}</h3><p>From the audit log. The last change of a setting can be undone.</p></div></div>
      <ul className="set-history-list">
        {shown.map((c) => <ChangeRow key={`${c.key}:${c.auditId}`} c={c} busy={undo.busy === c.auditId} onUndo={() => void undo.run(c)} />)}
      </ul>
      {items.length > 3 && <button type="button" className="btn btn-ghost btn-sm set-history-more" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${items.length}`}</button>}
    </section>
  );
}

function ChangeRow({ c, busy, onUndo, showPlace }: { c: SettingChange; busy: boolean; onUndo: () => void; showPlace?: SectionDef }) {
  return (
    <li className="set-change">
      <span className="set-change-main">
        <b>{c.setting}</b>
        <span>{c.wasUndo && <Badge tone="info">Undo</Badge>} {c.summary}</span>
        <small title={formatDateTime(c.at)}>{c.byName ?? 'Someone'} · {timeAgo(c.at)}{showPlace ? <> · <Link className="link" to={showPlace.to}>{showPlace.label}</Link></> : null}</small>
      </span>
      {c.canUndo
        ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title={c.undoTo ? `Put it back to ${c.undoTo}` : undefined} onClick={onUndo}><Icon name="undo" size={13} /> {busy ? 'Undoing…' : `Undo${c.undoTo ? ` (back to ${c.undoTo})` : ''}`}</button>
        : c.undoBlocked && c.undoBlocked !== 'Only the last change can be undone.' ? <span className="muted set-change-note" title={c.undoBlocked}>Cannot undo</span> : null}
    </li>
  );
}

// ================================================================== safe changes

/**
 * Before a risky switch is saved: who it affects and how. `confirm(req)` resolves true when the person goes ahead (or nothing gets
 * stricter), false when they go back. Render `element` once in the page.
 */
export function useImpactConfirm() {
  const [pending, setPending] = useState<{ data: SettingImpact; title: string; resolve: (ok: boolean) => void } | null>(null);
  const confirm = async (req: ImpactRequest, title: string): Promise<boolean> => {
    let data: SettingImpact;
    try { data = await settingsApi.impact(req); }
    catch (e) { toast(errText(e, 'Could not work out who this affects.'), 'error'); return false; }
    if (data.changes.length === 0) return true;
    return new Promise<boolean>((resolve) => setPending({ data, title, resolve }));
  };
  const done = (ok: boolean) => { pending?.resolve(ok); setPending(null); };
  const element = pending ? <ImpactModal title={pending.title} data={pending.data} onDone={done} /> : null;
  return { confirm, element };
}

function ImpactModal({ title, data, onDone }: { title: string; data: SettingImpact; onDone: (ok: boolean) => void }) {
  const [all, setAll] = useState(false);
  const people = all ? data.affected : data.affected.slice(0, 8);
  const danger = data.affected.length > 0 || data.records.some((r) => r.count > 0);
  return (
    <Modal title={title} subtitle="Check who this affects before you save." onClose={() => onDone(false)}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={() => onDone(false)}>Go back</button>
        <button type="button" className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={data.includesYou} onClick={() => onDone(true)}>
          {data.kind === 'retention' ? 'Save and delete when due' : danger ? `Save anyway (${data.people} affected)` : 'Save'}
        </button>
      </>}>
      <div className="impact">
        <ul className="impact-changes">{data.changes.map((c) => <li key={c}>{c}</li>)}</ul>
        <p className={`impact-headline ${danger ? 'warn' : 'ok'}`}><Icon name={danger ? 'alert' : 'checkCircle'} size={16} /> {data.headline}</p>
        {data.warning && <div className="form-warn" role="alert">{data.warning}</div>}
        {!data.enforced && <p className="muted">Your plan does not include these rules yet, so they are saved and take effect when you upgrade.</p>}
        {people.length > 0 && (
          <ul className="impact-people" aria-label="Who is affected">
            {people.map((p) => (
              <li key={p.userId}><b>{p.name}</b> <span className="muted">{p.email} · {p.role}</span>
                <ul>{p.reasons.map((r) => <li key={r}>{r}</li>)}</ul></li>
            ))}
          </ul>
        )}
        {data.affected.length > 8 && <button type="button" className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${data.affected.length}`}</button>}
        {data.records.length > 0 && (
          <table className="impact-records"><thead><tr><th>Record</th><th>Deleted</th><th>Older than</th></tr></thead>
            <tbody>{data.records.map((r) => <tr key={r.label}><td>{r.label}</td><td>{r.count.toLocaleString()}</td><td>{formatDateTime(r.before)}</td></tr>)}</tbody></table>
        )}
      </div>
    </Modal>
  );
}

// ================================================================== setup health

export function useSetupHealth() {
  const admin = useIsAdmin();
  return useWsQuery(['settings', 'health'], settingsApi.health, { enabled: admin, staleTime: 60_000, retry: false });
}

/** A short checklist of what this workspace still lacks, each with the button that fixes it. */
export function SetupHealthCard() {
  const wid = useWorkspaceId();
  const q = useSetupHealth();
  const nav = useNavigate();
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (q.isLoading) return <div className="card"><div className="card-body"><PageLoader /></div></div>;
  if (q.isError || !q.data || !Array.isArray(q.data.checks)) return null;
  const h = q.data;
  const open = h.checks.filter((c) => !c.ok && !c.dismissed);
  const rest = h.checks.filter((c) => c.ok || c.dismissed);
  const act = async (id: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(id);
    try { const r = await fn(); if (done) toast(done.replace('{n}', String((r as { sent?: number })?.sent ?? ''))); void invalidateWorkspace(wid, 'settings', 'health'); }
    catch (e) { toast(errText(e, 'Could not do that.'), 'error'); }
    finally { setBusy(null); }
  };
  const tone = h.score >= 85 ? 'good' : h.score >= 60 ? 'fair' : 'poor';
  const row = (c: SetupCheck) => (
    <li key={c.id} className={`health-item ${c.ok ? 'ok' : c.dismissed ? 'dismissed' : c.severity}`} data-check={c.id}>
      <span className="health-mark" aria-hidden><Icon name={c.ok ? 'checkCircle' : c.dismissed ? 'eyeOff' : 'alert'} size={16} /></span>
      <span className="health-main">
        <b>{c.title}</b>
        <span>{c.dismissed ? `Marked as not needed here${c.dismissReason ? `: ${c.dismissReason}` : ''}.` : c.detail}</span>
      </span>
      <span className="health-actions">
        {!c.ok && !c.dismissed && c.fix && <button type="button" className="btn btn-primary btn-sm" onClick={() => nav(c.fix!.to)}>{c.fix.label}</button>}
        {!c.ok && !c.dismissed && c.action === 'remind-two-step' && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => void act(c.id, settingsApi.remindTwoStep, 'Reminder sent to {n} member(s).')}>{c.actionLabel}</button>
        )}
        {!c.ok && !c.dismissed && c.canDismiss && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => void act(c.id, () => settingsApi.dismiss(c.id))}>Not needed</button>
        )}
        {c.dismissed && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === c.id} onClick={() => void act(c.id, () => settingsApi.restore(c.id))}>Bring back</button>}
      </span>
    </li>
  );
  return (
    <section className="card health" aria-label="Setup health">
      <div className="card-head">
        <div className="health-score-wrap">
          <span className={`health-score ${tone}`} role="img" aria-label={`Setup health ${h.score} out of 100`}>{h.score}</span>
          <div><h3>Setup health</h3><p>{open.length === 0 ? 'Nothing left to set up. Well done.' : `${open.length} thing${open.length === 1 ? '' : 's'} this workspace still lacks, most important first.`}</p></div>
        </div>
      </div>
      <ul className="health-list">{open.map(row)}</ul>
      {rest.length > 0 && (
        <>
          <button type="button" className="btn btn-ghost btn-sm health-toggle" aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>
            <Icon name="chevronD" size={13} /> {showDone ? 'Hide' : 'Show'} {rest.length} done or not needed
          </button>
          {showDone && <ul className="health-list done">{rest.map(row)}</ul>}
        </>
      )}
    </section>
  );
}

// ================================================================== the Settings home

/** Settings home: find any setting by typing, see what the workspace still lacks, the latest changes, and the seven groups. */
export function SettingsHome() {
  const sections = useWorkspaceSections();
  const admin = useIsAdmin();
  const canHistory = useCanSeeHistory();
  const recent = useWsQuery(['settings', 'changes', 'recent'], () => settingsApi.recent(8), { enabled: canHistory, staleTime: 30_000, retry: false });
  const undo = useUndo();
  const groups = SETTINGS_GROUPS.map((g) => ({ g, items: sections.filter((s) => s.group === g) })).filter((x) => x.items.length > 0);
  return (
    <>
      <PageHead title="Overview" sub="Everything about how this workspace is set up, in seven groups. Type to find any setting." />
      <div className="set-home-search"><SettingsSearch autoFocus /></div>
      {admin && <SetupHealthCard />}
      <div className="set-groups">
        {groups.map(({ g, items }) => (
          <section key={g} className="set-group card" aria-label={g}>
            <div className="set-group-head"><span className="set-group-ico"><Icon name={GROUP_INFO[g].icon ?? 'settings'} size={17} /></span><div><h3>{g}</h3><p>{GROUP_INFO[g].blurb}</p></div></div>
            <ul>{items.map((s) => <li key={s.id}><Link to={s.to}><span><b>{s.label}</b><small>{s.blurb}</small></span><Icon name="chevronR" size={14} /></Link></li>)}</ul>
          </section>
        ))}
      </div>
      {canHistory && (recent.data?.items?.length ?? 0) > 0 && (
        <section className="card set-history" aria-label="Latest changes">
          <div className="card-head"><div><h3><Icon name="clock" size={15} /> Latest changes</h3><p>Who changed which setting, from the audit log.</p></div>
            {sections.some((s) => s.id === 'audit') && <Link className="btn btn-ghost btn-sm" to="/settings/audit">Audit log</Link>}</div>
          <ul className="set-history-list">
            {recent.data!.items.map((c) => <ChangeRow key={`${c.key}:${c.auditId}`} c={c} busy={undo.busy === c.auditId} onUndo={() => void undo.run(c)} showPlace={sections.find((s) => s.id === c.section)} />)}
          </ul>
        </section>
      )}
      {recent.isError && <ErrorState error={recent.error} />}
    </>
  );
}

/** A small wrapper that gives a block of settings its search anchor and "last changed" line. */
export function SettingBlock({ id, section, children, className }: { id: string; section: string; children: ReactNode; className?: string }) {
  return <div className={className} data-setting={id}>{children}<LastChanged k={id} section={section} /></div>;
}
