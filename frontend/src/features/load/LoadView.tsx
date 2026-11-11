import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { CalmOrb, CalmSheet } from '../../components/calm';
import { ErrorState, EmptyState } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ApiError } from '../../api/client';
import { PortfolioSkeleton, useShellLine, useShellMenu } from '../projects/PortfolioShell';
import { loadApi, loadKeys, STATE_LABEL, undoMoves, type LoadDay, type LoadRow, type LoadScope, type LoadState, type LoadSuggestion } from './loadApi';
import './load.css';

const CapacityPlanView = lazy(() => import('../projects/CapacityPlan').then((m) => ({ default: m.CapacityPlanView })));

const SCOPES: { id: LoadScope; label: string }[] = [{ id: 'people', label: 'People' }, { id: 'teams', label: 'Teams' }, { id: 'projects', label: 'Projects' }];
const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const at = (iso: string) => new Date(`${iso}T00:00:00`);
const hours = (m: number) => { const h = Math.round(m / 6) / 10; return `${Number.isInteger(h) ? h : h.toFixed(1)}h`; };
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const first = (name: string) => name.split(/\s+/)[0] ?? name;
const DISMISS = 'pt_load_dismissed';
const readDismissed = (): string[] => { try { const v = JSON.parse(sessionStorage.getItem(DISMISS) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** One day of the strip: height from the share of capacity, colour from the state (grey and flat on days off and leave). */
function Bar({ d, onPick, label }: { d: LoadDay; onPick?: () => void; label: string }) {
  const flat = d.state === 'off' || d.state === 'leave';
  const h = flat ? 6 : Math.max(16, Math.min(100, d.percent ?? 0));
  const text = `${label}: ${flat ? STATE_LABEL[d.state] : `${STATE_LABEL[d.state]}, ${hours(d.committedMinutes + d.meetingMinutes)} of ${hours(d.workingMinutes)}`}`;
  return onPick && !flat
    ? <button type="button" className={`ld-bar s-${d.state}`} style={{ ['--h' as string]: `${h}%` }} onClick={onPick} aria-label={text} title={text}><i /></button>
    : <span className={`ld-bar s-${d.state}`} style={{ ['--h' as string]: `${h}%` }} role="img" aria-label={text} title={text}><i /></span>;
}

function Strip({ row, count, letters, onDay }: { row: LoadRow; count: number; letters?: boolean; onDay?: (d: LoadDay) => void }) {
  const days = row.days.slice(0, count);
  return (
    <div className="ld-stripw">
      <div className="ld-strip" role="group" aria-label={`${row.name}, next ${days.length} days`}>
        {days.map((d) => <Bar key={d.date} d={d} label={`${DAY_NAME[at(d.date).getDay()]} ${at(d.date).getDate()}`} onPick={onDay ? () => onDay(d) : undefined} />)}
      </div>
      {letters && <div className="ld-dow" aria-hidden="true">{days.map((d) => <b key={d.date}>{DOW[at(d.date).getDay()]}</b>)}</div>}
    </div>
  );
}

const Pill = ({ s, short }: { s: LoadState; short?: boolean }) => <span className={`ld-pill s-${s}`}>{short && s === 'overloaded' ? 'Over' : STATE_LABEL[s]}</span>;
const Av = ({ row }: { row: { name: string; state: LoadState } }) => <span className={`ld-av s-${row.state}`} aria-hidden="true">{initials(row.name)}</span>;

/** Rebalance (Aura): the first suggestion, with one-tap Move (reassign + undo) and Not now. */
function Rebalance({ s, phone, onMove, onDismiss, busy }: { s: LoadSuggestion; phone: boolean; onMove: () => void; onDismiss: () => void; busy: boolean }) {
  return (
    <section className="ld-aura" aria-label="Rebalance suggestion">
      <CalmOrb />
      <div className="ld-aura-b">
        {phone
          ? <p><b>{first(s.fromName)} is overloaded {s.fromWhen}.</b> {first(s.toName)} is free {s.toWhen}.</p>
          : <><h3>Rebalance this week</h3><p>Move “{s.title}” ({hours(s.minutes)}) from {first(s.fromName)} to {first(s.toName)} — free {s.toWhen}.</p></>}
        <div className="ld-aura-a">
          <button type="button" className="ld-go" disabled={busy} onClick={onMove}>{busy ? 'Moving…' : phone ? `Move “${s.title}” to ${first(s.toName)}` : 'Move it'}</button>
          <button type="button" className="ld-ghost" onClick={onDismiss}>Not now</button>
        </div>
      </div>
    </section>
  );
}

/** The day card: what fills it, and "13h of 8h". */
function DayDetail({ userId, name, date, head = true }: { userId: string; name: string; date: string; head?: boolean }) {
  const q = useWsQuery(loadKeys.day(userId, date), () => loadApi.day(userId, date), { staleTime: 30_000 });
  const d = q.data;
  return (
    <div className="ld-day" aria-live="polite">
      {head && <div className="ld-day-h">{first(name)} · {DAY_NAME[at(date).getDay()]}</div>}
      {q.isLoading ? <div className="ld-day-sk" aria-label="Loading the day" />
        : q.isError || !d ? <p className="ld-mute">This day could not be loaded.</p>
        : <>
          <ul className="ld-day-l">
            {d.items.map((i) => <li key={`${i.kind}:${i.id}`}><i className="dot" aria-hidden="true" /><span>{i.title}{i.overdue && <em> · overdue</em>}</span><b>{hours(i.dayMinutes)}</b></li>)}
            {d.meetingMinutes > 0 && <li className="mtg"><i className="ring" aria-hidden="true" /><span>Meetings{d.meetings.length > 1 ? ` (${d.meetings.length})` : ''}</span><b>{hours(d.meetingMinutes)}</b></li>}
            {d.items.length === 0 && d.meetingMinutes === 0 && <li className="none">Nothing planned.</li>}
          </ul>
          <div className={`ld-day-t s-${d.state}`}>{hours(d.usedMinutes)} of {hours(d.workingMinutes)}</div>
        </>}
    </div>
  );
}

/**
 * Portfolio › Load (approved design load-desktop / load-phone): who can take more over the next two weeks. People, Teams or Projects, most
 * loaded first, a strip coloured by each day's state, the state and a one-line reason; a day opens what fills it; the ✦ card moves one item
 * from someone overloaded to someone it fits (with Undo). The weekly capacity grid stays in ⋯.
 */
export function LoadView() {
  const phone = useIsMobile();
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const scope = (SCOPES.some((s) => s.id === params.get('ls')) ? params.get('ls') : 'people') as LoadScope;
  const grid = params.get('grid') === '1';
  const setParam = (k: string, v: string | null) => setParams((cur) => { const n = new URLSearchParams(cur); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const q = useWsQuery(loadKeys.load(scope), () => loadApi.get(scope), { staleTime: 30_000, placeholderData: (p) => p, enabled: !grid });
  const sugg = useWsQuery(loadKeys.sugg, () => loadApi.suggestions(), { staleTime: 30_000, enabled: !grid });
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<{ userId: string; name: string; date: string } | null>(null);
  const [sheetDay, setSheetDay] = useState<{ userId: string; name: string; date: string } | null>(null);
  const refresh = () => Promise.all(['capacity', 'portfolio', 'tasks', 'task', 'my-work', 'work'].map((k) => qc.invalidateQueries({ queryKey: [wid, k] })));

  const setSignal = async (s: 'swamped' | 'room' | null) => {
    try { await loadApi.signal(s); toast(s === 'swamped' ? 'Noted: you’re swamped this week.' : s === 'room' ? 'Noted: you have room this week.' : 'Cleared.'); void refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save that.', 'error'); }
  };
  const mine = q.data?.mySignal ?? null;
  useShellMenu(grid
    ? [{ label: 'Back to Load', icon: 'gauge' as const, onSelect: () => setParam('grid', null) }]
    : [
      { label: 'I’m swamped this week', icon: 'alert' as const, hint: mine === 'swamped' ? 'Said' : undefined, onSelect: () => void setSignal(mine === 'swamped' ? null : 'swamped') },
      { label: 'I have room this week', icon: 'check' as const, hint: mine === 'room' ? 'Said' : undefined, onSelect: () => void setSignal(mine === 'room' ? null : 'room') },
      { label: 'Weekly capacity grid', icon: 'list' as const, hint: 'Six weeks, booked vs capacity', onSelect: () => setParam('grid', '1') },
    ]);
  useShellLine(null);

  const s = (sugg.data ?? []).find((x) => !dismissed.includes(x.itemId)) ?? null;
  const rows = useMemo(() => q.data?.rows ?? [], [q.data]);
  // Desktop: the day card shows the busiest person's hottest day until a day is clicked.
  const defaultDay = useMemo(() => {
    const p = rows.find((r) => r.kind === 'person');
    if (!p) return null;
    const hot = [...p.days].filter((d) => d.state !== 'off' && d.state !== 'leave').sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))[0];
    return hot ? { userId: p.id, name: p.name, date: hot.date } : null;
  }, [rows]);
  useEffect(() => { if (picked && !rows.some((r) => r.id === picked.userId)) setPicked(null); }, [rows, picked]);
  const shownDay = picked ?? defaultDay;

  const move = async (x: LoadSuggestion) => {
    setBusy(true);
    try {
      const res = await loadApi.reassign({ toUserId: x.toUserId, items: [{ kind: x.kind, id: x.itemId }] });
      toast(`Moved “${x.title}” to ${first(x.toName)}.`, 'success', { label: 'Undo', ms: 8000, onClick: () => { void undoMoves(res.items).then(refresh).then(() => toast('Moved back.')).catch(() => toast('Could not undo the move.', 'error')); } });
      await refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The move could not be saved.', 'error'); }
    finally { setBusy(false); }
  };
  const dismiss = (x: LoadSuggestion) => { const n = [...dismissed, x.itemId]; setDismissed(n); try { sessionStorage.setItem(DISMISS, JSON.stringify(n)); } catch { /* private window */ } };

  if (grid) return <Suspense fallback={<PortfolioSkeleton label="Loading capacity" />}><CapacityPlanView /></Suspense>;
  const seg = (
    <div className="ld-seg" role="tablist" aria-label="Load by">
      {SCOPES.map((x) => <button key={x.id} type="button" role="tab" aria-selected={scope === x.id} onClick={() => setParam('ls', x.id === 'people' ? null : x.id)}>{x.label}</button>)}
    </div>
  );
  const onDay = (r: LoadRow) => (r.kind === 'person' ? (d: LoadDay) => { const v = { userId: r.id, name: r.name, date: d.date }; if (phone) setSheetDay(v); else setPicked(v); } : undefined);
  // Desktop rows keep the reason to one line ("3 due Wed · 9h meetings"); the phone card has room for all of it.
  const sub = (r: LoadRow) => (phone ? r.reason : r.reason.split(' · ').slice(0, 2).join(' · ').replace(/ tasks due /, ' due '));
  const aura = s && scope === 'people' ? <Rebalance s={s} phone={phone} busy={busy} onMove={() => void move(s)} onDismiss={() => dismiss(s)} /> : null;

  const body = q.isLoading ? <PortfolioSkeleton label="Loading load" />
    : q.isError || !q.data ? <ErrorState error={q.error} retry={() => void q.refetch()} />
    : rows.length === 0 ? <div className="ld-card"><EmptyState icon="users" title={scope === 'teams' ? 'No teams to show' : scope === 'projects' ? 'No open project work' : 'Nobody to show'} text="Load comes from assigned work, meetings and leave." /></div>
    : phone
      ? <div className="ld-cards">{rows.map((r) => (
        <article key={`${r.kind}:${r.id}`} className="ld-pc" aria-label={`${r.name}: ${STATE_LABEL[r.state]}`}>
          <header><Av row={r} /><b className="ld-nm">{r.name}</b><Pill s={r.state} /></header>
          <Strip row={r} count={10} letters onDay={onDay(r)} />
          <p className="ld-why">{sub(r)}</p>
        </article>))}</div>
      : <div className="ld-card ld-list" role="table" aria-label="Load for the next two weeks">
        {rows.map((r) => (
          <div key={`${r.kind}:${r.id}`} className={`ld-row${picked?.userId === r.id ? ' on' : ''}`} role="row">
            <div className="ld-who" role="rowheader"><Av row={r} /><div><b className="ld-nm">{r.name}</b><small className="ld-why">{sub(r)}</small></div></div>
            <div role="cell" className="ld-cell"><Strip row={r} count={12} onDay={onDay(r)} /></div>
            <div role="cell" className="ld-pc-pill"><Pill s={r.state} /></div>
          </div>
        ))}
      </div>;

  return (
    <section className={`ld ${phone ? 'ld-phone' : ''}`} aria-label="Load">
      <div className="ld-top">{seg}</div>
      {phone ? <>{aura}{body}</> : (
        <div className="ld-grid">
          <div className="ld-main">{body}</div>
          <aside className="ld-side" aria-label="Rebalance and day detail">
            {aura}
            {shownDay && scope === 'people' && <div className="ld-card"><DayDetail key={`${shownDay.userId}:${shownDay.date}`} {...shownDay} /></div>}
            <div className="ld-card ld-how">How it’s worked out: open work spread over the days until it’s due, plus meetings, minus leave and holidays. Logged time only tunes estimates.</div>
          </aside>
        </div>
      )}
      <CalmSheet open={!!sheetDay} onClose={() => setSheetDay(null)} kind="bottom" title={sheetDay ? `${first(sheetDay.name)} · ${DAY_NAME[at(sheetDay.date).getDay()]}` : ''} label="Day detail">
        {sheetDay && <div className="ld ld-insheet"><DayDetail {...sheetDay} head={false} /></div>}
      </CalmSheet>
    </section>
  );
}
