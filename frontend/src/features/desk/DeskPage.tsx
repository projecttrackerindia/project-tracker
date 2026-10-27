import { ToolbarSeg } from '../../components/v2/ToolbarSeg';
import { openNew } from '../../components/v2/state';
import { Face } from '../../components/Face';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { chatApi, opsApi } from '../../api/endpoints';
import { workItemsApi, type WorkActivity, type WorkItemDetail, type WorkRow } from '../../api/workItemsApi';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useAi } from '../ai/Assistant';
import { useNow } from '../time/time';
import { fillMacro, MACROS } from '../work/deskLogic';
import { useWarRoom } from '../work/Desk';
import { clock, deskRing, firstLine, initials, leftLabel, type DeskTone } from './deskPageLogic';
import './desk-page.css';

type Tab = 'queue' | 'mine' | 'solved';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', email: 'mail', phone: 'phone', webhook: 'webhook', ai: 'AI employee', app: 'the app' };
const TONE_TEXT: Record<DeskTone, string> = { ok: 'var(--dq-green)', warn: '#c77700', late: '#d70015', idle: 'var(--ds-text-4)' };
const TONE_ARC: Record<DeskTone, string> = { ok: 'var(--dq-green)', warn: 'var(--dq-orange)', late: 'var(--dq-red)', idle: 'var(--ds-text-4)' };

/** The SLA ring of the desk: what is left of the window, draining green → amber (under 1h) → red (under 15m), with the time left inside. */
export function DeskRing({ row, now }: { row: Pick<WorkRow, 'slaStartAt' | 'slaDueAt' | 'slaState'>; now: number }) {
  const { left, tone } = deskRing(row.slaStartAt ?? null, row.slaDueAt ?? null, row.slaState ?? null, now);
  const C = 2 * Math.PI * 15;
  const breached = !!row.slaDueAt && (Date.parse(row.slaDueAt) <= now || row.slaState === 'Breached' || row.slaState === 'Missed');
  const label = row.slaDueAt ? (breached ? 'SLA breached' : `${leftLabel(row.slaDueAt, now)} left on the SLA`) : 'No service level';
  return (
    <span className={`dq-ring t-${tone}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r="15" fill="none" stroke="var(--dq-ring-track)" strokeWidth="3.5" />
        <circle cx="19" cy="19" r="15" fill="none" stroke={TONE_ARC[tone]} strokeWidth="3.5" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - left)} transform="rotate(-90 19 19)" />
      </svg>
      <i style={{ color: TONE_TEXT[tone] }}>{row.slaDueAt ? (breached ? 'late' : leftLabel(row.slaDueAt, now)) : '–'}</i>
    </span>
  );
}

/** Where a ticket came from: WhatsApp (green), mail (blue), anything else a grey dot. */
function ChannelIcon({ channel, size = 13 }: { channel: string | null | undefined; size?: number }) {
  if (channel === 'email') return (
    <svg className="dq-ch" width={size} height={size} viewBox="0 0 24 24" aria-label="E-mail" role="img"><rect x="2" y="5" width="20" height="14" rx="3" fill="#0a84ff" /><path d="M3 7l9 6 9-6" stroke="#fff" strokeWidth="1.8" fill="none" /></svg>
  );
  return (
    <svg className="dq-ch" width={size - 1} height={size - 1} viewBox="0 0 24 24" aria-label={channel === 'whatsapp' ? 'WhatsApp' : CHANNEL[channel ?? 'app'] ?? 'App'} role="img">
      <circle cx="12" cy="12" r="11" fill={channel === 'whatsapp' || !channel ? '#25d366' : channel === 'phone' ? '#ff9f0a' : '#8e8e93'} />
    </svg>
  );
}

const WhatsAppGlyph = () => (
  <svg className="dq-ch" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#25d366" /><path d="M8.2 7.3c.3-.4.8-.4 1-.1l1 1.9c.1.3 0 .6-.2.8l-.6.6c.6 1.3 1.6 2.3 2.9 2.9l.6-.6c.2-.2.5-.3.8-.2l1.9 1c.3.2.3.7-.1 1-.9.8-2.1.9-3.2.4-2-1-3.6-2.6-4.6-4.6-.5-1.1-.4-2.3.5-3.1z" fill="#fff" /></svg>
);

/** Account facts a customer usually writes in: loan / account numbers, amounts, phone and mail. */
function accountFacts(text: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  const acct = text.match(/\b(?:loan|a\/c|account|acct|agreement)\s*(?:no\.?|number|#|:)?\s*([A-Z]{0,5}[-‑]?\d{5,})\b/i) ?? text.match(/\b([A-Z]{2,5}[-‑]\d{5,})\b/);
  if (acct) out.push({ label: /loan/i.test(acct[0]) || /^[A-Z]{2,5}[-‑]/.test(acct[1]) ? 'Loan' : 'Account', value: acct[1] });
  const amt = text.match(/(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d+)?)/i);
  if (amt) out.push({ label: /emi/i.test(text) ? 'EMI' : 'Amount', value: `₹${amt[1]}` });
  const phone = text.match(/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/);
  if (phone) out.push({ label: 'Phone', value: phone[0] });
  const mail = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (mail) out.push({ label: 'Mail', value: mail[0] });
  return out;
}

const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

export function DeskPage() {
  const [tab, setTab] = useState<Tab>('queue');
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow(true);
  const me = useAuth((s) => s.ctx?.user);
  const wid = useWorkspaceId();
  const listRef = useRef<HTMLDivElement>(null);

  const list = useWsQuery(['desk', 'list', tab], () => workItemsApi.list({ kind: ['ticket'], status: tab === 'solved' ? 'closed' : 'open', mine: tab === 'mine' || undefined, limit: 200 }),
    { refetchInterval: 30_000 });
  const open = useWsQuery(['desk', 'list', 'queue'], () => workItemsApi.list({ kind: ['ticket'], status: 'open', limit: 200 }), { refetchInterval: 30_000 });

  const rows = useMemo(() => {
    const items = [...(list.data?.items ?? [])];
    const due = (r: WorkRow) => (r.slaDueAt ? Date.parse(r.slaDueAt) : Number.POSITIVE_INFINITY);
    return tab === 'solved' ? items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : items.sort((a, b) => due(a) - due(b) || a.key.localeCompare(b.key));
  }, [list.data, tab]);

  // The first tickets' details (who raised it, where from) for the queue rows; the same queries serve the open ticket.
  const shown = rows.slice(0, 12);
  const details = useQueries({ queries: shown.map((r) => ({ queryKey: [wid, 'desk', 'item', r.id], queryFn: () => workItemsApi.get(r.id), staleTime: 30_000, enabled: !!wid })) });
  const detailOf = (id: string) => details[shown.findIndex((r) => r.id === id)]?.data as WorkItemDetail | undefined;

  const qc = useQueryClient();
  const [busyRow, setBusyRow] = useState<string | null>(null);
  // Assign / Resolve from the queue row: the same PATCH as the open ticket, with its current version.
  const quick = async (r: WorkRow, f: { assigneeId?: string; status?: string }, done: string) => {
    setBusyRow(r.id);
    try { const w = detailOf(r.id) ?? await workItemsApi.get(r.id); await workItemsApi.update(r.id, { version: w.version, ...f }); toast(done); }
    catch (e) { toast(errText(e, 'Could not save the change.'), 'error'); }
    finally { setBusyRow(null); void qc.invalidateQueries({ queryKey: [wid, 'desk'] }); }
  };
  const current = rows.find((r) => r.id === selected) ?? rows[0] ?? null;
  useEffect(() => { if (!selected && rows[0]) setSelected(rows[0].id); }, [rows, selected]);

  const openRows = open.data?.items ?? [];
  const critical = openRows.filter((r) => r.priority === 'Critical').sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0] ?? null;
  const breaching = openRows.filter((r) => r.slaDueAt && Date.parse(r.slaDueAt) - now < 3600e3).length;

  // j / k move through the queue (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)))) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const i = rows.findIndex((r) => r.id === current?.id);
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        setSelected(next.id);
        listRef.current?.querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, current?.id]);

  return (
    <div className="dq-page dq-desk">
      <ToolbarSeg className="dq-tb">
        <div className="dq-seg" role="tablist" aria-label="Desk views">
          {(['queue', 'mine', 'solved'] as Tab[]).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => { setTab(t); setSelected(null); }}>
              {t === 'queue' ? 'Queue' : t === 'mine' ? 'Mine' : 'Solved'}
            </button>
          ))}
        </div>
      </ToolbarSeg>

      {critical && <Incident row={critical} now={now} />}

      <div className="dq-hd">
        <div>
          <div className={`dq-eyebrow${breaching > 0 ? ' hot' : ''}`}>{openRows.length === 0 ? 'All clear' : `${openRows.length} open`}{breaching > 0 ? ` · ${breaching} breaching within 1h` : openRows.length ? ' · none breaching' : ''}</div>
          <h1 className="dq-h1">Desk</h1>
        </div>
        <div className="dq-legend" aria-label="SLA colours">
          <span><i style={{ background: '#34c759' }} />On track</span>
          <span><i style={{ background: '#ff9f0a' }} />Under 1h</span>
          <span><i style={{ background: '#ff3b30' }} />Under 15m</span>
        </div>
      </div>

      <div className="dq-cols">
        <section className="dq-card dq-q" aria-label="Live queue">
          <div className="dq-qh"><h2 className="dq-h3">{tab === 'solved' ? 'Solved' : tab === 'mine' ? 'Mine' : 'Live queue'}</h2><span className="dq-faint">{tab === 'solved' ? 'latest first' : 'by SLA left'}</span></div>
          <div className="dq-qlist" ref={listRef} role="listbox" aria-label="Tickets" tabIndex={0}
            onKeyDown={(e: ReactKeyboardEvent) => { if (e.key === 'Enter' && current) setSelected(current.id); }}>
            {list.isLoading && <p className="dq-empty">Loading…</p>}
            {!list.isLoading && rows.length === 0 && <p className="dq-empty">{tab === 'solved' ? 'Nothing solved yet.' : 'No open tickets. The queue is clear.'}</p>}
            {rows.map((r) => {
              const d = detailOf(r.id);
              const who = [d?.reporter?.name, r.assignee?.name.split(' ')[0] ?? 'unassigned'].filter(Boolean).join(' · ');
              return (
                <div key={r.id} data-id={r.id} role="option" aria-selected={current?.id === r.id} className={`dq-t ${current?.id === r.id ? 'on' : ''}`} onClick={() => setSelected(r.id)}>
                  <DeskRing row={r} now={now} />
                  <div className="dq-tx">
                    <span className="dq-tmeta" data-testid="dq-row-meta"><span className={`dq-pill p-${r.priority.toLowerCase()}`}>{r.priority}</span>{[r.key, d?.channel ? `via ${CHANNEL[d.channel] ?? d.channel}` : null, r.typeName].filter(Boolean).join(' · ')}</span>
                    <b>{r.title}</b>
                    <small><ChannelIcon channel={d?.channel} />{who}</small>
                  </div>
                  {tab !== 'solved' && (
                    <span className="dq-tacts" onClick={(e) => e.stopPropagation()}>
                      {me && r.assignee?.id !== me.id && <button type="button" className="dq-btn sm white" disabled={busyRow === r.id} onClick={() => void quick(r, { assigneeId: me.id }, 'Assigned to you.')}>Assign</button>}
                      <button type="button" className="dq-btn sm" disabled={busyRow === r.id} onClick={() => void quick(r, { status: 'Completed' }, 'Resolved.')}>Resolve</button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {current ? <Conversation key={current.id} row={current} me={me?.id ?? null} /> : <AllClear tab={tab} onSolved={() => { setTab('solved'); setSelected(null); }} />}
        {current ? <Context key={`c-${current.id}`} row={current} /> : <div className="dq-ctx" />}
      </div>
    </div>
  );
}

/** The red critical-incident strip: what is down, how long it has been, and the war room. */
function Incident({ row, now }: { row: WorkRow; now: number }) {
  const d = useWsQuery(['desk', 'item', row.id], () => workItemsApi.get(row.id), { staleTime: 30_000 });
  const started = d.data?.createdAt ?? row.updatedAt;
  const people = [d.data?.assignee?.name.split(' ')[0], ...(d.data?.activity ?? []).map((a) => a.actor?.name.split(' ')[0])].filter((x, i, a): x is string => !!x && a.indexOf(x) === i).slice(0, 2);
  const sub = [firstLine(d.data?.description), people.length ? `${people.join(' and ')} on it` : null].filter(Boolean).join(' · ');
  return (
    <div className="dq-inc" role="status">
      <span className="dq-live" aria-hidden="true" />
      <b>Critical incident · {row.key} {row.title}</b>
      {sub && <span className="dq-inc-sub">{sub}</span>}
      <span className="dq-sp" />
      <span className="dq-tm" title={`Raised ${new Date(started).toLocaleString()}`}>{clock(started, now)}</span>
      {d.data ? <WarRoomButton w={d.data} /> : <button type="button" className="dq-war" disabled>War room</button>}
    </div>
  );
}

function WarRoomButton({ w }: { w: WorkItemDetail }) {
  const { open, busy } = useWarRoom(w);
  return <button type="button" className="dq-war" disabled={busy} onClick={() => void open()}>{busy ? 'Opening…' : 'War room'}</button>;
}

/** The open ticket as a conversation: what was raised, then every comment, file and note in order, and the reply box. */
function Conversation({ row, me }: { row: WorkRow; me: string | null }) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const d = useWsQuery(['desk', 'item', row.id], () => workItemsApi.get(row.id), { staleTime: 30_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const w = d.data;
  const reload = () => { void qc.invalidateQueries({ queryKey: [wid, 'desk'] }); };

  // Edit on the suggested reply puts it here.
  useEffect(() => {
    const onDraft = (e: Event) => { const t = (e as CustomEvent<string>).detail; setText(t); box.current?.focus(); };
    window.addEventListener('dq-draft', onDraft);
    return () => window.removeEventListener('dq-draft', onDraft);
  }, []);

  const send = async () => {
    if (!text.trim() || !w) return;
    setBusy(true);
    try { await workItemsApi.comment(w.id, text.trim()); setText(''); reload(); }
    catch (e) { toast(errText(e, 'Could not send the reply.'), 'error'); }
    finally { setBusy(false); }
  };
  const save = async (f: { assigneeId?: string; status?: string }, done: string) => {
    if (!w) return;
    try { await workItemsApi.update(w.id, { version: w.version, ...f }); toast(done); reload(); }
    catch (e) { toast(errText(e, 'Could not save the change.'), 'error'); reload(); }
  };

  const channel = w?.channel ?? null;
  const reporter = w?.reporter?.id ?? null;
  const items = [...(w?.activity ?? [])].reverse().filter((a) => a.type === 'comment' || a.type === 'file' || a.type === 'ai');
  const type = (w?.detail as { workType?: string } | undefined)?.workType ?? row.typeName;
  const prio = row.priority;

  return (
    <section className="dq-card dq-conv" aria-label="Ticket">
      <div className="dq-ch-h">
        <div className="dq-row" style={{ gap: 10 }}>
          <span className={`dq-pill p-${prio.toLowerCase()}`}>{prio}</span>
          <span className="dq-faint dq-meta-line">{[row.key, `via ${CHANNEL[channel ?? 'app'] ?? channel}`, type].filter(Boolean).join(' · ')}</span>
          <span className="dq-sp" />
          {me && row.assignee?.id !== me && <button type="button" className="dq-btn sm" onClick={() => void save({ assigneeId: me }, 'Assigned to you.')}>Assign</button>}
          {row.category !== 'Done' && row.category !== 'Cancelled' && <button type="button" className="dq-btn sm pri" onClick={() => void save({ status: 'Completed' }, 'Resolved.')}>Resolve</button>}
        </div>
        <h2 className="dq-title">{row.title}</h2>
      </div>
      <div className="dq-msgs">
        {w && w.description && (
          <>
            <div className="dq-m-meta">{channel === 'whatsapp' ? <WhatsAppGlyph /> : <ChannelIcon channel={channel} size={15} />}{[w.reporter?.name, fmtTime(w.createdAt)].filter(Boolean).join(' · ')}</div>
            <div className="dq-m in">{w.description}</div>
          </>
        )}
        {items.map((a, i) => <Bubble key={a.id} a={a} prev={i > 0 ? items[i - 1] : null} reporter={reporter} channel={channel} />)}
        {w && !w.description && items.length === 0 && <p className="dq-empty">No messages yet.</p>}
      </div>
      <form className="dq-comp" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <span className="dq-orb" aria-hidden="true" />
        <textarea ref={box} rows={1} value={text} maxLength={4000} aria-label="Reply" placeholder={`Reply on ${channel === 'whatsapp' ? 'WhatsApp' : channel === 'email' ? 'mail' : 'the ticket'}…`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
        <button type="submit" className="dq-kbd" disabled={busy || !text.trim()} aria-label="Send (⌘ Enter)">⌘↵</button>
      </form>
    </section>
  );
}

function Bubble({ a, prev, reporter, channel }: { a: WorkActivity; prev: WorkActivity | null; reporter: string | null; channel: string | null }) {
  if (a.type === 'ai') return <div className="dq-m note">Internal · {a.summary}</div>;
  const incoming = !!reporter && a.actor?.id === reporter;
  const showMeta = !prev || prev.actor?.id !== a.actor?.id || prev.type === 'ai';
  const meta = [a.actor?.name ?? 'Someone', fmtTime(a.at), incoming ? null : 'Read'].filter(Boolean).join(' · ');
  return (
    <>
      {showMeta && <div className={`dq-m-meta ${incoming ? '' : 'r'}`}>{incoming && (channel === 'whatsapp' ? <WhatsAppGlyph /> : <ChannelIcon channel={channel} size={15} />)}{meta}</div>}
      {a.type === 'file' ? (
        <div className={`dq-m ${incoming ? 'in' : 'out'} file`}>
          <div className="dq-file"><span className="dq-file-ic">{(a.fileName?.split('.').pop() ?? 'FILE').slice(0, 4).toUpperCase()}</span>
            <div><b>{a.fileName ?? 'File'}</b><div className="dq-faint">{a.summary}</div></div></div>
        </div>
      ) : <div className={`dq-m ${incoming ? 'in' : 'out'}`}>{a.body ?? a.summary}</div>}
    </>
  );
}

/** Right column: who raised it, the linked project, similar solved tickets and a suggested reply. */
function Context({ row }: { row: WorkRow }) {
  const qc = useQueryClient();
  const wid = useWorkspaceId();
  const ai = useAi();
  const d = useWsQuery(['desk', 'item', row.id], () => workItemsApi.get(row.id), { staleTime: 30_000 });
  const w = d.data;
  const triage = useWsQuery(['desk', 'triage', row.id], () => opsApi.triage({ title: row.title, description: w?.description ?? null }),
    { staleTime: 5 * 60_000, retry: false, enabled: !!w && row.title.trim().length >= 3 });
  const draft = useWsQuery(['desk', 'draft', row.id], () => chatApi.ask(`Draft a short, friendly reply to the person who raised support ticket ${row.key} "${row.title}". ` +
    `Use how similar problems were solved before and any matching help documents. Reply text only, at most three sentences.${w?.description ? `\n\nTicket details: ${w.description.slice(0, 1200)}` : ''}`),
  { staleTime: 30 * 60_000, retry: false, enabled: ai && !!w });
  const [sending, setSending] = useState(false);
  const reply = (draft.data?.found !== false && draft.data?.answer?.trim()) || fillMacro(MACROS[0].text, w?.reporter?.name);
  const similar = (triage.data?.duplicates ?? []).filter((x) => x.key !== row.key).slice(0, 2);
  const reporter = w?.reporter?.name ?? '—';
  const type = (w?.detail as { workType?: string } | undefined)?.workType ?? row.typeName;
  const related = (w?.detail as { relatedProject?: { id: string; name: string; key?: string } | null } | undefined)?.relatedProject ?? null;
  const project = w?.projectName ? { name: w.projectName, key: w.projectKey } : related ? { name: related.name, key: related.key ?? null } : null;

  // The customer's account facts, read from what they wrote; past tickets from the same person among recent ones.
  const facts = accountFacts(w?.description ?? '');
  const recent = useWsQuery(['desk', 'list', 'all-recent'], () => workItemsApi.list({ kind: ['ticket'], status: 'all', limit: 60 }), { staleTime: 60_000 });
  const others = (recent.data?.items ?? []).filter((x) => x.id !== row.id).slice(0, 40);
  const pastQ = useQueries({ queries: others.map((x) => ({ queryKey: [wid, 'desk', 'item', x.id], queryFn: () => workItemsApi.get(x.id), staleTime: 5 * 60_000, enabled: !!wid && !!w?.reporter })) });
  const past = w?.reporter ? others.filter((_, i) => (pastQ[i]?.data as WorkItemDetail | undefined)?.reporter?.id === w.reporter!.id) : [];
  const pastLoading = recent.isLoading || pastQ.some((x) => x.isLoading);
  const pastCount = past.length;

  const send = async () => {
    if (!w) return;
    setSending(true);
    try { await workItemsApi.comment(w.id, reply); toast('Reply sent.'); void qc.invalidateQueries({ queryKey: [wid, 'desk'] }); }
    catch (e) { toast(errText(e, 'Could not send the reply.'), 'error'); }
    finally { setSending(false); }
  };

  return (
    <aside className="dq-ctx" aria-label="Context">
      <div className="dq-card dq-cc">
        <div className="dq-row" style={{ gap: 10, marginBottom: 10 }}>
          <Face userId={w?.reporter?.id} name={reporter} byName className="dq-av" text={initials(reporter)} />
          <div style={{ minWidth: 0 }}><b className="dq-name">{reporter}</b><div className="dq-faint dq-s12">{[type, w ? `since ${new Date(w.createdAt).getFullYear()}` : null].filter(Boolean).join(' · ')}</div></div>
        </div>
        <div className="dq-kv"><span>Ticket</span><b>{row.key}</b></div>
        <div className="dq-kv"><span>Owner</span><b>{row.assignee && <Face userId={row.assignee.id} name={row.assignee.name} className="dq-own-av" />}{row.assignee?.name ?? 'unassigned'}</b></div>
        <div className="dq-kv"><span>Status</span><b>{row.status}</b></div>
      </div>
      <div className="dq-card dq-cc" data-testid="dq-customer">
        <div className="dq-lbl">Account</div>
        {facts.length === 0 && pastCount === 0 ? <div className="dq-faint dq-s12">No account details in the ticket.</div> : <>
          {facts.map((f) => <div key={f.label + f.value} className="dq-kv"><span>{f.label}</span><b>{f.value}</b></div>)}
          <div className="dq-kv"><span>Past tickets</span><b>{pastLoading ? '…' : past.length === 0 ? 'None' : `${past.length} · ${past.filter((x) => x.category === 'Done').length} solved`}</b></div>
          {past.slice(0, 3).map((x) => <div key={x.id} className="dq-sim"><span className="dq-ok" aria-hidden="true">{x.category === 'Done' ? '✓' : '•'}</span><span>{x.title} · <span className="dq-faint">{x.key}</span></span></div>)}
        </>}
      </div>
      <div className="dq-card dq-cc">
        <div className="dq-lbl">Linked</div>
        {project ? <div className="dq-row dq-linked"><i />{project.name}<span className="dq-faint">{project.key ?? ''}</span></div> : <div className="dq-faint dq-s12">No linked project.</div>}
      </div>
      <div className="dq-card dq-cc">
        <div className="dq-lbl">Similar, solved</div>
        {triage.isLoading && w ? <div className="dq-faint dq-s12">Looking…</div> : similar.length === 0 ? <div className="dq-faint dq-s12">Nothing similar yet.</div> : similar.map((s) => (
          <div key={s.id} className="dq-sim"><span className="dq-ok" aria-hidden="true">✓</span><span>{s.title} · <span className="dq-faint">{s.key}{s.assignee ? ` · ${s.assignee.name.split(' ')[0]}` : ''}</span></span></div>
        ))}
      </div>
      <div className="dq-card dq-ai">
        <div className="dq-ai-line"><span className="dq-orb" aria-hidden="true" /><span>{draft.isLoading && ai ? 'Drafting a reply from similar tickets…' : `“${reply}”`}</span></div>
        <div className="dq-row" style={{ gap: 8, marginTop: 12, paddingLeft: 26 }}>
          <button type="button" className="dq-btn sm pri" disabled={sending || !w} onClick={() => void send()}>{sending ? 'Sending…' : 'Send'}</button>
          <button type="button" className="dq-btn sm white" onClick={() => window.dispatchEvent(new CustomEvent('dq-draft', { detail: reply }))}>Edit</button>
        </div>
      </div>
    </aside>
  );
}

/** The right side when there is nothing to open: how the desk did lately, and the next useful step — not an empty panel. */
function AllClear({ tab, onSolved }: { tab: Tab; onSolved: () => void }) {
  const solved = useWsQuery(['desk', 'list', 'solved'], () => workItemsApi.list({ kind: ['ticket'], status: 'closed', limit: 200 }), { staleTime: 60_000 });
  const items = solved.data?.items ?? [];
  const since = (days: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - days); return d.getTime(); };
  const today = items.filter((r) => Date.parse(r.updatedAt) >= since(0)).length;
  const week = items.filter((r) => Date.parse(r.updatedAt) >= since(6)).length;
  const last = items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return (
    <section className="dq-card dq-conv dq-allclear" aria-label="All clear">
      <div className="dq-allclear-mark" aria-hidden="true">✓</div>
      <h2>{tab === 'mine' ? 'Nothing assigned to you' : tab === 'solved' ? 'Nothing solved yet' : 'The queue is clear'}</h2>
      <p>New tickets from mail, WhatsApp, the portal and chat land here with their SLA clock.</p>
      <dl className="dq-allclear-stats">
        <div><dt>Solved today</dt><dd>{solved.isLoading ? '…' : today}</dd></div>
        <div><dt>This week</dt><dd>{solved.isLoading ? '…' : week}</dd></div>
        <div><dt>Last solved</dt><dd>{last ? <span title={last.title}>{last.key}</span> : '—'}</dd></div>
      </dl>
      <div className="dq-allclear-acts">
        <button type="button" className="dq-btn pri" onClick={() => openNew('ticket')}>New ticket</button>
        {tab !== 'solved' && <button type="button" className="dq-btn" onClick={onSolved}>See solved</button>}
      </div>
    </section>
  );
}

