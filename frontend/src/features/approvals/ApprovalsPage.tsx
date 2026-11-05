import { Select } from '../../components/Select';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { CalmAvatar, CalmCard, CalmGo, CalmPage, CalmPills, CalmRailCard, CalmRailRow, CalmSplit, CalmOrb, CalmSkeleton } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { approvalsApi, TYPES, typeOf, type Approval, type ApprovalList, type ApprovalView, type DecideAction } from './api';
import { ApprovalRequestHost, openApprovalRequest } from './host';
import { ChainCell } from './RequestSheet';
import { TypeTile } from './TypeIcon';
import './approvals.css';

const first = (name: string | null | undefined) => (name ?? '').split(' ')[0] || name || 'Someone';
const NOBODY = { id: '', name: 'Someone' };
/** One request with every list and person filled in, so a missing approver or field shows as "Someone" instead of breaking the page. */
function safe(a: Approval): Approval {
  return { ...a, requester: a.requester ?? NOBODY, links: a.links ?? [], payload: a.payload ?? {}, events: a.events ?? null,
    steps: (a.steps ?? []).map((s) => ({ ...s, approver: s.approver ?? NOBODY })) };
}
const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "35m", "2h", "Mon", "29 Oct": how long ago, the way the list says it. */
function age(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h`;
  const d = new Date(iso);
  return m < 60 * 24 * 6 ? d.toLocaleDateString('en-GB', { weekday: 'short' }) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
/** "2h left", "35m left", "expired". */
function left(iso: string | null, now = Date.now()) {
  if (!iso) return null;
  const m = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (m <= 0) return 'expiring now';
  return m < 60 ? `${m}m left` : m < 60 * 48 ? `${Math.round(m / 60)}h left` : `${Math.round(m / 1440)} days left`;
}

/** Where the chain stands, step by step, as the cells show it. */
function cellState(a: Approval, i: number, me: string): { state: 'd' | 'n' | 'w' | 'r'; note: string } {
  const s = a.steps[i];
  if (s.status === 'Approved') return { state: 'd', note: 'Approved' };
  if (s.status === 'Rejected') return { state: 'r', note: 'Rejected' };
  if (s.status === 'Pending') return { state: 'n', note: s.approver.id === me ? 'Your turn' : 'Deciding' };
  if (s.status === 'Skipped') return { state: 'w', note: 'Not needed' };
  return { state: 'w', note: 'Waiting' };
}

function Chain({ a, me }: { a: Approval; me: string }) {
  return (
    <div className="ap-chain" aria-label="Approval chain">
      {a.steps.map((s, i) => { const c = cellState(a, i, me); return <ChainCell key={s.order} role={s.role} name={s.approver.name} userId={s.approver.id} state={c.state} note={c.note} last={i === a.steps.length - 1} />; })}
    </div>
  );
}

/** The one sentence under the hero title: who already said yes, and where you are in the chain. */
function why(a: Approval, me: string) {
  if (a.summary) return a.summary;
  const done = a.steps.filter((s) => s.status === 'Approved').map((s) => `${first(s.approver.name)} (${s.role})`);
  const mineStep = a.steps.find((s) => s.status === 'Pending' && s.approver.id === me);
  const last = mineStep && mineStep.order === a.steps.length;
  return `${done.length ? `${done.join(' and ')} approved. ` : ''}${mineStep ? (last ? `You’re the final ${mineStep.role.toLowerCase()} sign-off.` : `You’re step ${mineStep.order} of ${a.steps.length}.`) : ''}`.trim();
}

/**
 * Approvals: what needs your decision (the most urgent request as the hero, the rest as rows), what you asked for, everything open, and the
 * history of decisions; a request's chain and timeline; and the rail with this week's numbers, counts by type and what expires today.
 * Release sign-offs and timesheet reviews stay in their own places and are linked from here.
 */
export function ApprovalsPage() {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user.id ?? '');
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = (['needs', 'mine', 'all', 'history'].includes(params.get('view') ?? '') ? params.get('view') : 'needs') as ApprovalView;
  const type = params.get('type') ?? '';
  const openId = params.get('open');
  const setParam = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v) n.set(k, v); else n.delete(k); if (k !== 'open') n.delete('open'); return n; }, { replace: k !== 'open' });
  const list = useWsQuery(['approvals', view, type], () => approvalsApi.list(view, type), { refetchInterval: 300_000, placeholderData: (p) => p });
  const detail = useWsQuery(['approvals', 'one', openId], () => approvalsApi.get(openId!), { enabled: !!openId });
  const [busy, setBusy] = useState<string | null>(null);

  const decide = async (a: Approval, action: DecideAction, comment?: string) => {
    if (busy) return;
    setBusy(a.id);
    const key = [wid, 'approvals', view, type];
    const before = queryClient.getQueryData<ApprovalList>(key);
    // Optimistic: a decided request leaves "needs me" at once.
    if (before && (action === 'approve' || action === 'reject') && view === 'needs')
      queryClient.setQueryData<ApprovalList>(key, { ...before, items: before.items.filter((x) => x.id !== a.id), counts: { ...before.counts, needsMe: Math.max(0, before.counts.needsMe - 1) } });
    try {
      const out = await approvalsApi.decide(a.id, action, comment);
      queryClient.setQueryData([wid, 'approvals', 'one', a.id], out);
      void invalidateWorkspace(wid, 'approvals');
      toast({ approve: out.status === 'Approved' ? '✓ Approved' : `✓ Approved · now with ${out.steps.find((s) => s.status === 'Pending')?.approver.name ?? 'the next approver'}`,
        reject: '✓ Rejected', comment: '✓ Sent', withdraw: '✓ Withdrawn', remind: '✓ Reminder sent' }[action], 'success');
    } catch (e) {
      if (before) queryClient.setQueryData(key, before);
      toast(e instanceof ApiError ? e.message : 'Could not save that.', 'error');
    } finally { setBusy(null); }
  };

  if (list.isLoading && !list.data) return <CalmPage width="full" className="ap-page" label="Approvals"><CalmSkeleton label="Loading approvals" /></CalmPage>;
  if (list.error && !list.data) return <ErrorState error={list.error} retry={() => list.refetch()} />;
  // Every part of the answer is read defensively: an older server (or a request whose approver left) must never blank the page.
  const raw = list.data!;
  const data: ApprovalList = { ...raw, items: (raw.items ?? []).map(safe), counts: { needsMe: 0, mine: 0, all: 0, history: 0, ...(raw.counts as Partial<ApprovalList['counts']> | undefined) },
    week: { approved: 0, rejected: 0, expired: 0, medianMinutes: null, ...(raw.week as Partial<ApprovalList['week']> | undefined) }, byType: raw.byType ?? {}, expiringToday: raw.expiringToday ?? 0, elsewhere: raw.elsewhere ?? [] };
  const c = data.counts;
  const items = data.items;
  const hero = view === 'needs' ? items[0] : undefined;
  const rest = hero ? items.slice(1) : items;
  const open = openId ? (detail.data ? safe(detail.data) : undefined) ?? items.find((x) => x.id === openId) : undefined;

  const head = view === 'history' ? ['History.', 'Every decision, with who and why.']
    : view === 'mine' ? [c.mine ? `${c.mine} waiting on others.` : 'Nothing waiting on others.', c.mine ? 'You asked for these.' : 'Ask with Request approval.']
    : view === 'all' ? [`${c.all} open request${c.all === 1 ? '' : 's'}.`, 'Everything you can see.']
    : c.needsMe ? [`${c.needsMe} approval${c.needsMe === 1 ? ' needs' : 's need'} you.`, hero ? `The ${typeOf(hero.type).label.toLowerCase()} first.` : '']
    : ['Nothing needs you.', 'Every request is decided.'];

  const remindAll = async () => {
    const mine = await approvalsApi.list('mine');
    const soon = mine.items.filter((a) => a.expiresAt && new Date(a.expiresAt).getTime() - Date.now() < 86_400_000);
    if (!soon.length) { toast('Nothing of yours expires today.', 'info'); return; }
    await Promise.allSettled(soon.map((a) => approvalsApi.decide(a.id, 'remind')));
    toast(`✓ Reminded ${soon.length === 1 ? 'the approver' : `${soon.length} approvers`}`, 'success');
  };

  const max = Math.max(20, data.week.approved, data.week.rejected, data.week.expired);
  const typesShown = TYPES.filter((t) => (data.byType[t.id] ?? 0) > 0);
  const rail = (
    <>
      <CalmRailCard title="This week">
        {([['Approved', data.week.approved, 'var(--calm-p2)'], ['Rejected', data.week.rejected, 'var(--calm-p5)'], ['Expired', data.week.expired, 'var(--calm-p4)']] as const).map(([l, n, col]) => (
          <div key={l} className="ap-mb"><span>{l}</span><div className="calm-bar thin" role="progressbar" aria-label={l} aria-valuenow={n} aria-valuemin={0} aria-valuemax={max}><i style={{ width: `${(n / max) * 100}%`, background: col }} /></div><b>{n}</b></div>
        ))}
        <p className="ap-rail-note">{data.week.medianMinutes != null ? `Median decision time ${data.week.medianMinutes < 90 ? `${data.week.medianMinutes} min` : `${Math.round(data.week.medianMinutes / 60)} h`}.` : 'No decisions yet this week.'}</p>
      </CalmRailCard>
      <CalmRailCard title="By type">
        {(typesShown.length ? typesShown : TYPES.slice(0, 6)).map((t) => (
          <CalmRailRow key={t.id} lead={<TypeTile type={t.id} />} title={t.label} right={data.byType[t.id] ?? 0} onClick={() => setParam('type', type === t.id ? null : t.id)} className={type === t.id ? 'on' : ''} />
        ))}
      </CalmRailCard>
      {data.expiringToday > 0 && (
        <CalmRailCard tone="tip">
          <CalmOrb />
          <span>{data.expiringToday === 1 ? 'One request expires' : `${data.expiringToday === 2 ? 'Two' : data.expiringToday} requests expire`} today if nobody decides. <button type="button" onClick={() => void remindAll()}>Remind approvers</button></span>
        </CalmRailCard>
      )}
    </>
  );

  return (
    <CalmPage width="full" className="ap-page" label="Approvals">
      <ApprovalRequestHost />
      <div className="ap-crumb">{open ? <><button type="button" className="ap-lk" onClick={() => setParam('open', null)}>Approvals</button><span aria-hidden="true">›</span><span>{open.title}</span></> : <span>Approvals</span>}</div>
      <CalmSplit rail={rail}>
        <h1 className="ap-hero-title">{head[0]}{head[1] && <em>{head[1]}</em>}</h1>
        <div className="ap-bar">
          <CalmPills label="Show" value={view} onChange={(v) => setParam('view', v === 'needs' ? null : v)} options={[
            { value: 'needs', label: 'Needs me', count: c.needsMe }, { value: 'mine', label: 'Requested by me', count: c.mine },
            { value: 'all', label: 'All', count: c.all }, { value: 'history', label: 'History' },
          ]} />
          <span className="ap-sp" />
          <label className="ap-filter"><Icon name="filter" size={14} />
            <Select aria-label="Type" value={type} onChange={(e) => { const v = e.target.value; if (v.startsWith('/')) nav(v); else setParam('type', v || null); }}>
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              {data.elsewhere.map((e) => <option key={e.kind} value={e.href}>{e.label} ({e.count}) ›</option>)}
            </Select><Icon name="chevronD" size={12} />
          </label>
          <CalmGo onClick={() => openApprovalRequest()}>Request approval</CalmGo>
        </div>
        <div className="ap-body">
          {open ? <Detail a={open} me={me} busy={busy === open.id} onClose={() => setParam('open', null)} onDecide={decide} />
            : view === 'history' ? <History items={items} onOpen={(id) => setParam('open', id)} />
            : (
              <>
                {hero && <Hero a={hero} me={me} busy={busy === hero.id} onDecide={decide} onOpen={() => setParam('open', hero.id)} />}
                {rest.length > 0 && (
                  <CalmCard variant="list" className="ap-list">
                    {rest.map((a) => <Row key={a.id} a={a} onOpen={() => setParam('open', a.id)} />)}
                  </CalmCard>
                )}
                {!hero && rest.length === 0 && (
                  <CalmCard className="ap-empty"><b>{view === 'needs' ? 'You’re all caught up.' : 'Nothing here.'}</b>New requests show up here, and in the bell, the moment someone asks.</CalmCard>
                )}
              </>
            )}
        </div>
      </CalmSplit>
    </CalmPage>
  );
}

function Row({ a, onOpen }: { a: Approval; onOpen: () => void }) {
  const t = typeOf(a.type);
  const where = a.links.map((l) => l.label).slice(0, 2).join(' · ') || Object.values(a.payload).slice(0, 2).join(' · ');
  return (
    <button type="button" className="ap-row" onClick={onOpen}>
      <TypeTile type={a.type} />
      <span className="ap-t"><b>{a.title}</b><small>{t.label}{where ? ` · ${where}` : ''}</small></span>
      <span className="ap-po"><CalmAvatar userId={a.requester.id} name={a.requester.name} />{first(a.requester.name)}</span>
      <span className={`ap-rk${a.risk === 'High' ? ' hi' : ''}`}>{a.risk} risk</span>
      <span>{a.needsMe ? <span className="ap-chip on">Needs you</span> : <span className="ap-chip">{a.status === 'Pending' ? 'Waiting' : a.status}</span>}</span>
      <span className="ap-age">{age(a.createdAt)}</span>
    </button>
  );
}

function Hero({ a, me, busy, onDecide, onOpen }: { a: Approval; me: string; busy: boolean; onDecide: (a: Approval, act: DecideAction, c?: string) => void; onOpen: () => void }) {
  const [ask, setAsk] = useState<'reject' | 'comment' | null>(null);
  const [text, setText] = useState('');
  const t = typeOf(a.type);
  const linked = a.links.map((l) => l.label).join(' · ');
  const riskColor = a.risk === 'High' ? 'var(--calm-orange)' : a.risk === 'Medium' ? 'var(--calm-p4)' : 'var(--calm-green)';
  const send = () => { if (!ask) return; onDecide(a, ask, text.trim() || undefined); setAsk(null); setText(''); };
  return (
    <CalmCard variant="hero" className="ap-hero" aria-label={a.title}>
      <TypeTile type={a.type} lg />
      <div className="ap-hero-main">
        <div className="ap-tag-line">{t.label} · from {a.requester.name}{left(a.expiresAt) ? ` · ${left(a.expiresAt)} to decide` : ''}</div>
        <h2>{a.title}</h2>
        <p className="ap-why">{why(a, me)}</p>
        <div className="ap-meta">
          <div><small>Risk</small><b><i style={{ background: riskColor }} />{a.risk}{a.impact && a.type !== 'Deployment' ? ` · ${a.impact}` : ''}</b></div>
          <div><small>{a.type === 'Leave' ? 'Dates' : 'Impact'}</small><b>{a.type === 'Leave' ? [a.payload.from, a.payload.to].filter(Boolean).join(' – ') : a.impact ?? a.payload.window ?? a.payload.environment ?? '—'}</b></div>
          <div><small>Linked</small><b>{linked || '—'}</b></div>
        </div>
        <Chain a={a} me={me} />
        {ask ? (
          <div className="ap-ask">
            <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label={ask === 'reject' ? 'Why are you rejecting it?' : 'Your question'}
              placeholder={ask === 'reject' ? 'Why? (they will see this)' : 'Ask the requester…'} onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') setAsk(null); }} />
            <CalmGo onClick={send} disabled={busy || (ask === 'comment' && !text.trim())}>{ask === 'reject' ? 'Reject' : 'Send'}</CalmGo>
            <button type="button" className="ap-lk" onClick={() => setAsk(null)}>Cancel</button>
          </div>
        ) : (
          <div className="ap-acts">
            {a.needsMe && <CalmGo onClick={() => onDecide(a, 'approve')} disabled={busy}>Approve</CalmGo>}
            {a.needsMe && <button type="button" className="ap-pill" onClick={() => setAsk('reject')}>Reject</button>}
            <button type="button" className="ap-lk" onClick={() => setAsk('comment')}>Ask a question</button>
            <button type="button" className="ap-lk" onClick={onOpen}>Details ›</button>
          </div>
        )}
      </div>
    </CalmCard>
  );
}

function History({ items, onOpen }: { items: Approval[]; onOpen: (id: string) => void }) {
  if (!items.length) return <CalmCard className="ap-empty"><b>No decisions yet.</b>Approved, rejected and expired requests are kept here with who decided and why.</CalmCard>;
  return (
    <CalmCard variant="list" className="ap-list" aria-label="History">
      {items.map((a) => {
        const decider = [...a.steps].reverse().find((s) => s.status === 'Approved' || s.status === 'Rejected');
        const why = a.status === 'Expired' ? 'No response in time.' : decider?.comment ? `“${decider.comment}”` : a.status === 'Withdrawn' ? 'Withdrawn by the requester.' : '';
        const who = decider?.approver ?? a.requester;
        return (
          <button key={a.id} type="button" className="ap-hrow" onClick={() => onOpen(a.id)}>
            <span className="ap-hd">{new Date(a.decidedAt ?? a.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
            <span className={`ap-hdot ${a.status}`} aria-hidden="true" />
            <TypeTile type={a.type} />
            <span className="ap-t"><b>{a.title}</b><small>{typeOf(a.type).label}{why ? ` · ${why}` : ''}</small></span>
            <span className="ap-po"><CalmAvatar userId={who.id} name={who.name} />{who.name}</span>
            <span className={`ap-hs ${a.status}`}>{a.status}</span>
          </button>
        );
      })}
    </CalmCard>
  );
}

const ACTION: Record<string, string> = { Requested: 'requested', Approved: 'approved', Rejected: 'rejected', Commented: 'asked', Withdrawn: 'withdrew it', Expired: 'Expired' };

function Detail({ a, me, busy, onClose, onDecide }: { a: Approval; me: string; busy: boolean; onClose: () => void; onDecide: (a: Approval, act: DecideAction, c?: string) => void }) {
  const [ask, setAsk] = useState<'reject' | 'comment' | null>(null);
  const [text, setText] = useState('');
  const t = typeOf(a.type);
  const current = a.steps.find((s) => s.status === 'Pending');
  const fields = useMemo(() => {
    const known = t.fields.filter((f) => a.payload[f.key]).map((f) => [f.label, a.payload[f.key]] as const);
    const extra = Object.entries(a.payload).filter(([k]) => !t.fields.some((f) => f.key === k)).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), v] as const);
    return [...known, ...extra];
  }, [a, t]);
  const send = () => { if (!ask) return; onDecide(a, ask, text.trim() || undefined); setAsk(null); setText(''); };
  const ends = a.status === 'Pending' && a.expiresAt ? `Expires in ${left(a.expiresAt)?.replace(' left', '')} if no decision` : a.status !== 'Pending' ? `${a.status}${a.decidedAt ? ` ${new Date(a.decidedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}` : '';
  return (
    <CalmCard className="ap-detail" aria-label={`${a.title}: details`}>
      <div className="ap-detail-head">
        <TypeTile type={a.type} lg />
        <div><small>{t.label} · requested by {a.requester.name} · {hm(a.createdAt)}</small><h2>{a.title}</h2></div>
        <button type="button" className="ap-x" onClick={onClose} aria-label="Close details"><Icon name="close" size={13} /></button>
      </div>
      <div className="ap-ps">Approval chain · step {Math.min(a.currentStep, a.steps.length)} of {a.steps.length}</div>
      <Chain a={a} me={me} />
      <div className="ap-grid2">
        <div>
          <div className="ap-ps">Details</div>
          {fields.length ? fields.map(([k, v]) => <div key={k} className="ap-ipr"><span>{k}</span><b>{v}</b></div>) : <div className="ap-ipr"><span>No details given</span></div>}
          {a.links.length > 0 && <div className="ap-ipr"><span>Linked</span><b className="ap-else">{a.links.map((l, i) => l.href ? <Link key={i} className="ap-tag" to={l.href}>{l.label}</Link> : <span key={i} className="ap-tag">{l.label}</span>)}</b></div>}
          {a.outcome?.startsWith('PlannedLeave:') && <div className="ap-ipr"><span>Timesheet</span><b><Link to="/insights?tab=time&s=week">Leave is on your timesheet ›</Link></b></div>}
        </div>
        <div>
          <div className="ap-ps">Timeline</div>
          {(a.events ?? []).map((e) => (
            <div key={e.id} className="ap-ili">
              {e.user ? <CalmAvatar userId={e.user.id} name={e.user.name} /> : <span className="calm-av" style={{ background: 'var(--calm-ink3)' }} />}
              <span>{e.user ? `${first(e.user.name)} ${ACTION[e.action] ?? e.action.toLowerCase()}` : ACTION[e.action]}{e.action === 'Approved' && e.step ? ` (${a.steps[e.step - 1]?.role ?? ''})` : ''}{e.comment ? ` · “${e.comment}”` : ''}</span>
              <time dateTime={e.at}>{hm(e.at)}</time>
            </div>
          ))}
          {current && <div className="ap-ili"><CalmAvatar userId={current.approver.id} name={current.approver.name} /><span>{current.approver.id === me ? 'Waiting on you' : `Waiting on ${first(current.approver.name)}`}</span><time>now</time></div>}
        </div>
      </div>
      {ask && (
        <div className="ap-ask">
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} aria-label={ask === 'reject' ? 'Why are you rejecting it?' : 'Your question'}
            placeholder={ask === 'reject' ? 'Why? (they will see this)' : 'Write a comment or question…'} onKeyDown={(e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') setAsk(null); }} />
          <CalmGo onClick={send} disabled={busy || (ask === 'comment' && !text.trim())}>{ask === 'reject' ? 'Reject' : 'Send'}</CalmGo>
        </div>
      )}
      <div className="ap-detail-foot">
        {a.needsMe && <CalmGo onClick={() => onDecide(a, 'approve')} disabled={busy}>Approve</CalmGo>}
        {a.needsMe && <button type="button" className="ap-pill" onClick={() => setAsk('reject')}>Reject</button>}
        {a.status === 'Pending' && <button type="button" className="ap-lk" onClick={() => setAsk('comment')}>Ask a question</button>}
        {a.mine && a.status === 'Pending' && <button type="button" className="ap-lk" onClick={() => onDecide(a, 'remind')}>Remind {current ? first(current.approver.name) : 'approver'}</button>}
        {a.mine && a.status === 'Pending' && <button type="button" className="ap-lk" onClick={() => onDecide(a, 'withdraw')}>Withdraw</button>}
        {ends && <span className="ap-note">{ends}</span>}
      </div>
    </CalmCard>
  );
}

/** The Approvals tab's own number (requests waiting on you), for the shell's sidebar. */
export function useApprovalCounts(enabled = true) {
  return useWsQuery(['approvals', 'counts'], approvalsApi.counts, { refetchInterval: 300_000, staleTime: 30_000, enabled });
}

export default ApprovalsPage;
