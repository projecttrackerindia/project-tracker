import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { chatApi, opsApi, workApi, workspaceApi } from '../../api/endpoints';
import type { ChatAskAnswer, Priority } from '../../api/types';
import { workItemsApi, type WorkItemDetail, type WorkItemPatch } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { PriorityOptions } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useAi } from '../ai/Assistant';
import { useNow } from '../time/time';
import { MACROS, elapsed, fillMacro, slaRing } from './deskLogic';
import './desk.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
type Save = (f: Omit<WorkItemPatch, 'version'>) => Promise<boolean>;

/** A ticket's SLA as a small ring: the share of the window used; green, amber from 75%, red when breached. */
export function SlaRing({ start, due, state }: { start: string; due: string; state: string | null }) {
  const { used, tone } = slaRing(start, due, state);
  const pct = Math.round(used * 100);
  const label = tone === 'late' ? 'SLA breached' : tone === 'paused' ? `SLA paused, ${pct}% used` : `${pct}% of the SLA used`;
  return <span className={`dk-ring t-${tone}`} style={{ ['--used' as string]: `${pct * 3.6}deg` }} role="img" aria-label={label} title={`${label} · due ${new Date(due).toLocaleString()}`} />;
}

// ------------------------------------------------------------------ critical incident mode

/** Opens (or reopens) the ticket's war room: a Talk group with the people on it, remembered per ticket in this browser. */
export function useWarRoom(w: WorkItemDetail) {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx?.user?.id);
  const [busy, setBusy] = useState(false);
  const storeKey = `pm_warroom_${w.id}`;

  const open = async () => {
    setBusy(true);
    try {
      let id: string | null = null;
      try { id = localStorage.getItem(storeKey); } catch { /* private window */ }
      if (id) {
        try { await chatApi.conversation(id); } catch { id = null; }   // deleted, or no longer a member
      }
      if (!id) {
        // The people on it: owner, reporter and everyone who has commented or changed it.
        const people = new Set<string>();
        if (w.assignee) people.add(w.assignee.id);
        if (w.reporter) people.add(w.reporter.id);
        for (const a of w.activity) if (a.actor?.id) people.add(a.actor.id);
        if (me) people.delete(me);
        const c = await chatApi.createGroup(`War room · ${w.key}`.slice(0, 80), [...people]);
        id = c.id;
        try { localStorage.setItem(storeKey, id); } catch { /* private window */ }
        await chatApi.send(id, `🚨 Critical incident ${w.key}: ${w.title}\nOpen it: ${window.location.origin}/work?item=${w.id}`);
        void workItemsApi.comment(w.id, `War room opened in Talk (“War room · ${w.key}”).`).catch(() => undefined);
      }
      nav(`/talk/${encodeURIComponent(id)}`);
    } catch (e) { toast(errText(e, 'Could not open the war room.'), 'error'); }
    finally { setBusy(false); }
  };
  return { open, busy };
}

/** Critical open ticket: a red strip with the time since it was raised, and a War room that gathers the people in a Talk group. */
export function IncidentStrip({ w }: { w: WorkItemDetail }) {
  const now = useNow(true);
  const { open, busy } = useWarRoom(w);
  const started = (w.detail as { createdAt?: string }).createdAt ?? w.createdAt;

  return (
    <div className="dk-incident" role="status">
      <span className="dk-incident-dot" aria-hidden="true" />
      <b>Critical incident</b>
      <span className="dk-incident-time" title={`Raised ${new Date(started).toLocaleString()}`}>{elapsed(started, now)}</span>
      <button type="button" className="dk-incident-btn" disabled={busy} onClick={() => void open()}><Icon name="message" size={14} />{busy ? 'Opening…' : 'War room'}</button>
    </div>
  );
}

// ------------------------------------------------------------------ triage chips on new tickets

/** Suggested type, priority and owner for a new ticket (the desk's own triage, from past tickets), each with Accept or Change. */
export function TriageChips({ w, save }: { w: WorkItemDetail; save: Save }) {
  const d = w.detail as { workTypeId?: string };
  const q = useWsQuery(['ops', 'triage', 'panel', w.id], () => opsApi.triage({ title: w.title, description: w.description, workTypeId: d.workTypeId ?? null }),
    { staleTime: 5 * 60_000, retry: false, enabled: w.title.trim().length >= 3 });
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true), { staleTime: 5 * 60_000 });
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000 });
  const [done, setDone] = useState<Set<string>>(new Set());
  const [changing, setChanging] = useState<string | null>(null);
  const r = q.data;
  if (!r) return null;
  const chips: { id: 'type' | 'priority' | 'owner'; label: string; value: string; why: string | null; accept: () => Promise<boolean> }[] = [];
  if (r.workTypeId && r.workType && r.workTypeId !== d.workTypeId) chips.push({ id: 'type', label: 'Category', value: r.workType, why: r.typeReason, accept: () => save({ workTypeId: r.workTypeId! }) });
  if (r.priority && r.priority !== w.priority) chips.push({ id: 'priority', label: 'Priority', value: r.priority, why: r.priorityReason, accept: () => save({ priority: r.priority! }) });
  if (r.assignee && !w.assignee) chips.push({ id: 'owner', label: 'Team / owner', value: r.assignee.name, why: r.assigneeReason, accept: () => save({ assigneeId: r.assignee!.id }) });
  const shown = chips.filter((c) => !done.has(c.id));
  if (shown.length === 0) return null;
  const finish = (id: string) => setDone((s) => new Set(s).add(id));

  return (
    <div className="dk-triage" aria-label="Triage suggestions">
      <span className="dk-triage-h"><Icon name="sparkle" size={13} /> Triage</span>
      {shown.map((c) => (
        <div key={c.id} className="dk-chip" title={c.why ?? undefined}>
          <span className="dk-chip-l">{c.label}</span><b>{c.value}</b>
          {changing === c.id ? (
            c.id === 'type' ? (
              <select autoFocus aria-label="Category" defaultValue="" onChange={(e) => { if (e.target.value) void save({ workTypeId: e.target.value }).then(() => finish(c.id)); setChanging(null); }}>
                <option value="" disabled>Choose…</option>{(types.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : c.id === 'priority' ? (
              <select autoFocus aria-label="Priority" defaultValue={w.priority} onChange={(e) => { void save({ priority: e.target.value as Priority }).then(() => finish(c.id)); setChanging(null); }}><PriorityOptions /></select>
            ) : (
              <select autoFocus aria-label="Owner" defaultValue="" onChange={(e) => { if (e.target.value) void save({ assigneeId: e.target.value }).then(() => finish(c.id)); setChanging(null); }}>
                <option value="" disabled>Choose…</option>{(members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
              </select>
            )
          ) : (
            <>
              <button type="button" className="dk-chip-ok" onClick={() => void c.accept().then((ok) => { if (ok) finish(c.id); })}>Accept</button>
              <button type="button" className="dk-chip-alt" onClick={() => setChanging(c.id)}>Change</button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ suggested reply and macros

/** A first reply drafted by the workspace's AI from the Library and past conversations, or a macro; edited here and posted as a comment. */
export function ReplyHelper({ w, onPosted }: { w: WorkItemDetail; onPosted: () => void }) {
  const ai = useAi();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<ChatAskAnswer | null>(null);
  const [busy, setBusy] = useState<'draft' | 'post' | null>(null);

  const draft = async () => {
    setBusy('draft');
    try {
      const a = await chatApi.ask(`Draft a short, friendly reply to the person who raised support ticket ${w.key} "${w.title}". Use how similar problems were solved before ` +
        `and any matching help documents; give concrete steps. Reply text only.${w.description ? `\n\nTicket details: ${w.description.slice(0, 1200)}` : ''}`);
      setAnswer(a);
      setText(a.answer.trim());
    } catch (e) { toast(errText(e, 'Could not draft a reply.'), 'error'); }
    finally { setBusy(null); }
  };
  const post = async () => {
    if (!text.trim()) return;
    setBusy('post');
    try { await workItemsApi.comment(w.id, text.trim()); setText(''); setAnswer(null); setOpen(false); toast('Reply posted.'); onPosted(); }
    catch (e) { toast(errText(e, 'Could not post the reply.'), 'error'); }
    finally { setBusy(null); }
  };

  if (!open) return (
    <button type="button" className="dk-reply-open" onClick={() => { setOpen(true); if (ai && !text) void draft(); }}>
      <Icon name="sparkle" size={14} /> {ai ? 'Suggest a reply' : 'Reply with a macro'}
    </button>
  );
  return (
    <section className="dk-reply" aria-label="Suggested reply">
      <div className="dk-reply-h">
        <b>Reply</b>
        <div className="dk-macros">
          {MACROS.map((m) => <button key={m.id} type="button" className="dk-macro" onClick={() => { setText(fillMacro(m.text, w.reporter?.name)); setAnswer(null); }}>{m.label}</button>)}
          {ai && <button type="button" className="dk-macro ai" disabled={busy !== null} onClick={() => void draft()}><Icon name="sparkle" size={12} />{busy === 'draft' ? 'Drafting…' : 'Draft again'}</button>}
        </div>
      </div>
      <textarea className="textarea" rows={5} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} aria-label="Reply"
        placeholder={busy === 'draft' ? 'Drafting from similar tickets and the Library…' : 'Write a reply, or pick a macro'} />
      {answer && answer.citations.length > 0 && (
        <p className="dk-reply-src">From: {answer.citations.slice(0, 3).map((c) => c.conversationName).join(' · ')}</p>
      )}
      {answer && !answer.found && <p className="dk-reply-src">Nothing similar was found; check the draft before sending.</p>}
      <div className="dk-reply-acts">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Close</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || busy !== null} onClick={() => void post()}>{busy === 'post' ? 'Posting…' : 'Post reply'}</button>
      </div>
    </section>
  );
}
