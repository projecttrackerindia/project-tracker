import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, download, uploadFile } from '../../api/client';
import { projectApi, workApi, workspaceApi } from '../../api/endpoints';
import type { Priority, WorkSla } from '../../api/types';
import { workItemsApi, type WorkActivity, type WorkItemDetail, type WorkItemPatch, type WorkKind } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { AiCard } from '../../components/v2/AiCard';
import { SidePanel } from '../../components/v2/SidePanel';
import { useCopilot, useSaveState } from '../../components/v2/state';
import { ErrorState, PageLoader, PriorityOptions } from '../../components/ui';
import { dateOffset, daysUntil, formatDate, formatDateTime, formatTime } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { WORK_STATUSES } from '../../lib/workLabels';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { DotsMenu } from '../talk/DotsMenu';
import { useAi } from '../ai/Assistant';
import { DevLinks } from '../settings/IntegrationSettings';
import { formatMinutes } from '../time/time';
import { IncidentStrip, ReplyHelper, TriageChips } from './Desk';
import { SlaChip } from './Sla';
import { SupportResolution } from './SupportResolution';
import { KIND_LONG, dueText, refreshWork } from './workUi';
import './work.css';

const TaskModal = lazy(() => import('../tasks/TaskModal').then((m) => ({ default: m.TaskModal })));
const WorkTaskModal = lazy(() => import('./WorkTaskModal').then((m) => ({ default: m.WorkTaskModal })));

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
/** Each kind's own statuses, as the PATCH takes them (a task's are its project's columns, read separately). */
const STATUSES: Record<Exclude<WorkKind, 'task'>, { id: string; label: string }[]> = {
  ticket: WORK_STATUSES.map((s) => ({ id: s.id, label: s.label })),
  issue: [{ id: 'Observed', label: 'Observed' }, { id: 'InProgress', label: 'In progress' }, { id: 'Fixed', label: 'Fixed' }, { id: 'Resolved', label: 'Resolved' }],
  action: [{ id: 'Open', label: 'Open' }, { id: 'InProgress', label: 'In progress' }, { id: 'Completed', label: 'Completed' }],
};
/** Suggestions put away with "Not now", for this visit. */
const dismissed = new Set<string>();

/** Short "2h", "3d", "just now" for the stream; the full time is in the tooltip. */
function ago(iso: string) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : formatDate(iso);
}
const canEditOf = (w: WorkItemDetail) => {
  const d = w.detail as { canEdit?: boolean; can?: { edit?: boolean } };
  return d.canEdit ?? d.can?.edit ?? true;
};
const canDeleteOf = (w: WorkItemDetail) => {
  const d = w.detail as { canEdit?: boolean; can?: { delete?: boolean } };
  return d.can?.delete ?? d.canEdit ?? false;
};
/** The current status as its PATCH value. */
const statusValue = (w: WorkItemDetail) => (w.kind === 'task' ? String((w.detail as { statusId?: string }).statusId ?? '') : String((w.detail as { status?: string }).status ?? ''));

/**
 * One work item in the right-hand panel (V2-SPEC §3.3): status, priority, owner and due as four tiles changed in place, saved as you go
 * (with the version read, so a change made by someone else in between is never overwritten); a ✦ Copilot card with one suggested action;
 * a ticket's SLA, channel and resolution; the files; and one Activity stream of comments, time, files, field changes and AI actions, with
 * a comment box where "log 2h" logs time. Opened by a row, and by /work?item=<id>.
 */
export function WorkItemPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const key = useMemo(() => [wid, 'work-items', 'item', id], [wid, id]);
  const q = useWsQuery(['work-items', 'item', id], () => workItemsApi.get(id), { retry: (n, e) => !(e instanceof ApiError && (e.status === 404 || e.status === 403)) && n < 2 });
  const { state, run } = useSaveState();
  const [conflict, setConflict] = useState(false);
  // All the details (the task sheet or the ticket form) for what the panel leaves out; in the address (?full=1) so it survives a reload.
  const [params, setParams] = useSearchParams();
  const full = params.get('full') === '1';
  const setFull = (on: boolean) => setParams((p) => { const n = new URLSearchParams(p); if (on) n.set('full', '1'); else n.delete('full'); return n; }, { replace: true });
  useEffect(() => { setConflict(false); }, [id]);
  const w = q.data?.id ? q.data : undefined;

  /**
   * Saves one change with the version last read. A 409 means someone saved in between: read it again and say so. Changes made quickly one
   * after another wait for each other, so each is sent with the version the one before it produced (never a clash with yourself).
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (fields: Omit<WorkItemPatch, 'version'>): Promise<boolean> => {
    // What shows at once: the simple fields change in place while the save is on its way.
    const shown = queryClient.getQueryData<WorkItemDetail>(key);
    const quick = (['title', 'description', 'priority', 'dueDate'] as const).filter((f) => f in fields);
    if (shown && quick.length) queryClient.setQueryData<WorkItemDetail>(key, { ...shown, ...Object.fromEntries(quick.map((f) => [f, fields[f]])) });
    const next = queue.current.then(() => send(fields));
    queue.current = next.catch(() => undefined);
    return next;
  };
  const send = async (fields: Omit<WorkItemPatch, 'version'>): Promise<boolean> => {
    const cur = queryClient.getQueryData<WorkItemDetail>(key) ?? w;
    if (!cur) return false;
    try {
      const next = await run(() => workItemsApi.update(id, { version: cur.version, ...fields }));
      queryClient.setQueryData(key, next);
      setConflict(false);
      refreshWork(wid);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);   // the panel says so at its top, where the tiles are
        await q.refetch();
      } else { toast(errText(e, 'Could not save that change.'), 'error'); void q.refetch(); }   // and back to what is saved
      return false;
    }
  };

  const remove = async () => {
    if (!w || !(await confirmDialog({ title: `Delete ${w.key}?`, message: `“${w.title}” will be removed.`, confirmText: 'Delete', danger: true }))) return;
    try { await workItemsApi.remove(id); toast(`${w.key} deleted.`, 'warning'); refreshWork(wid); onClose(); }
    catch (e) { toast(errText(e, 'Could not delete it.'), 'error'); }
  };
  const copy = () => {
    const url = `${window.location.origin}${window.location.pathname.replace(/\/work(\/.*)?$/, '/work')}?item=${id}`;
    void navigator.clipboard?.writeText(url).then(() => toast('Link copied.'), () => toast(url, 'info'));
  };

  const nav = useNavigate();
  const menu = w ? (
    <DotsMenu label="More for this item" items={[
      { label: 'Copy link', icon: 'link', onSelect: copy },
      { label: 'Open its project', icon: 'folder', hidden: !w.projectId, onSelect: () => nav(`/work/projects/${w.projectId}`) },
      { label: w.kind === 'task' ? 'All task details' : 'All ticket details', hint: w.kind === 'task' ? 'Checklist, subtasks, dependencies, labels' : 'Time entries, triage, reminders', icon: 'note',
        hidden: w.kind !== 'task' && w.kind !== 'ticket', onSelect: () => setFull(true) },
      { label: 'Delete', icon: 'trash', danger: true, hidden: !canDeleteOf(w), onSelect: () => void remove() },
    ]} />
  ) : null;

  return (
    <>
      <SidePanel docked width={520} onClose={onClose} state={state} label={w ? `${w.key} ${w.title}` : 'Work item'} actions={menu}
        eyebrow={w ? <span className="wkp-eyebrow">{w.key} · {KIND_LONG[w.kind]}{w.projectName && w.kind !== 'ticket' ? ` · ${w.projectName}` : ''}</span> : undefined}
        title={w ? <TitleEdit key={`${w.id}:${w.version}`} value={w.title} disabled={!canEditOf(w)} onSave={(title) => save({ title })} /> : 'Work item'}>
        {q.isLoading ? <PageLoader /> : q.isError || !w ? (
          <ErrorState error={q.error instanceof ApiError && q.error.status === 404 ? new ApiError(404, 'This item does not exist any more, or you cannot open it.', []) : q.error} retry={() => void q.refetch()} />
        ) : (
          <PanelBody w={w} save={save} conflict={conflict} onDismissConflict={() => setConflict(false)} refetch={() => void q.refetch()} />
        )}
      </SidePanel>
      <Suspense fallback={null}>
        {full && w?.kind === 'task' && <TaskModal taskId={w.id} onClose={() => { setFull(false); void q.refetch(); refreshWork(wid); }} />}
        {full && w?.kind === 'ticket' && <WorkTaskModal taskId={w.id} onClose={() => { setFull(false); void q.refetch(); refreshWork(wid); }} />}
      </Suspense>
    </>
  );
}

/** The title, editable where it stands: Enter or leaving the field saves, Esc puts it back. */
function TitleEdit({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [v]);
  const commit = () => { const t = v.trim(); if (!t) { setV(value); return; } if (t !== value) void onSave(t).then((ok) => { if (!ok) setV(value); }); };
  return (
    <textarea ref={ref} className="wkp-title" rows={1} value={v} disabled={disabled} aria-label="Title" maxLength={200} onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setV(value); } }} />
  );
}

function PanelBody({ w, save, conflict, onDismissConflict, refetch }: {
  w: WorkItemDetail; save: (f: Omit<WorkItemPatch, 'version'>) => Promise<boolean>; conflict: boolean; onDismissConflict: () => void; refetch: () => void;
}) {
  const editable = canEditOf(w);
  const me = useAuth((s) => s.ctx?.user);
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000 });
  const people = (members.data ?? []).filter((m) => m.role !== 'Guest');
  const project = useWsQuery(['project', w.projectId], () => projectApi.get(w.projectId!), { enabled: w.kind === 'task' && !!w.projectId, staleTime: 60_000 });
  const statuses = w.kind === 'task'
    ? [...(project.data?.statuses ?? [])].sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, label: s.name }))
    : STATUSES[w.kind];
  const current = statusValue(w);
  const statusOptions = statuses.some((s) => s.id === current) ? statuses : [{ id: current, label: w.status }, ...statuses];

  // Pushing a task's due date later needs a reason (the Portfolio shows why delivery moved): asked for right here before saving.
  const [dueAsk, setDueAsk] = useState<{ to: string | null } | null>(null);
  useEffect(() => { setDueAsk(null); }, [w.id]);
  const setDue = (to: string | null) => {
    if (to === w.dueDate) return;
    const later = !!w.dueDate && (!to || to > w.dueDate);
    if (w.kind === 'task' && later) { setDueAsk({ to }); return; }
    void save({ dueDate: to });
  };
  const setStatus = (v: string) => void save(w.kind === 'task' ? { statusId: v } : { status: v });

  return (
    <div className="wkp">
      {conflict && (
        <div className="wkp-conflict" role="alert">
          <Icon name="alert" size={15} /><span>Someone else changed this while you had it open. You are now looking at their version; make your change again.</span>
          <button type="button" className="btn-icon" aria-label="Dismiss" onClick={onDismissConflict}><Icon name="close" size={14} /></button>
        </div>
      )}
      {w.kind === 'ticket' && w.priority === 'Critical' && (w.category === 'Todo' || w.category === 'Active') && <IncidentStrip w={w} />}
      <div className="wkp-tiles">
        <Tile label="Status" value={w.status} tone={w.category === 'Done' ? 'done' : w.category === 'Active' ? 'active' : undefined} disabled={!editable}>
          <select aria-label="Status" value={current} onChange={(e) => setStatus(e.target.value)} disabled={!editable}>
            {statusOptions.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </Tile>
        <Tile label="Priority" value={<><span className={`wk-dot p-${w.priority}`} aria-hidden="true" />{w.priority}</>} disabled={!editable}>
          <select aria-label="Priority" value={w.priority} onChange={(e) => void save({ priority: e.target.value as Priority })} disabled={!editable}><PriorityOptions /></select>
        </Tile>
        <Tile label="Owner" value={w.assignee ? (w.assignee.id === me?.id ? `${w.assignee.name.split(' ')[0]} (you)` : w.assignee.name) : 'Nobody yet'} disabled={!editable}>
          <select aria-label="Owner" value={w.assignee?.id ?? ''} onChange={(e) => void save({ assigneeId: e.target.value || null })} disabled={!editable}>
            <option value="">Nobody yet</option>
            {w.assignee && !people.some((p) => p.userId === w.assignee!.id) && <option value={w.assignee.id}>{w.assignee.name}</option>}
            {people.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}{m.userId === me?.id ? ' (you)' : ''}</option>)}
          </select>
        </Tile>
        <Tile label="Due" value={w.dueDate ? `${dueText(w.dueDate, w.isOverdue)}${daysUntil(w.dueDate)! > 1 ? '' : ` · ${formatDate(w.dueDate).slice(0, 6)}`}` : 'No date'} tone={w.isOverdue ? 'late' : undefined} disabled={!editable}>
          <input type="date" aria-label="Due date" value={w.dueDate ?? ''} disabled={!editable} onChange={(e) => setDue(e.target.value || null)} />
        </Tile>
      </div>
      {dueAsk && <DueReason from={w.dueDate} to={dueAsk.to} onCancel={() => setDueAsk(null)} onSave={async (reason) => { if (await save({ dueDate: dueAsk.to, dueDateReason: reason })) setDueAsk(null); }} />}

      <Copilot w={w} me={me?.id ?? null} save={save} onDueAsk={(to) => setDueAsk({ to })} onStatus={setStatus} statuses={statuses} refetch={refetch} />

      {w.kind === 'ticket' && w.category === 'Todo' && editable && <TriageChips w={w} save={save} />}
      {w.kind === 'ticket' && <TicketFields w={w} editable={editable} save={save} />}
      {w.kind !== 'ticket' && (w.projectName || w.loggedMinutes > 0) && (
        <dl className="wkp-fields">
          {w.projectName && <div><dt>Project</dt><dd>{w.projectName}</dd></div>}
          {w.kind === 'issue' && (w.detail as { stageName?: string | null }).stageName && <div><dt>Stage</dt><dd>{(w.detail as { stageName?: string }).stageName}</dd></div>}
          {w.loggedMinutes > 0 && <div><dt>Time logged</dt><dd>{formatMinutes(w.loggedMinutes)}</dd></div>}
        </dl>
      )}

      <Description key={`${w.id}:${w.version}`} value={w.description ?? ''} disabled={!editable} onSave={(description) => save({ description: description || null })} />
      <Files w={w} editable={editable} onAdded={refetch} />
      {(w.kind === 'task' || w.kind === 'ticket') && <div className="wkp-dev">{w.kind === 'task' ? <DevLinks taskId={w.id} /> : <DevLinks workTaskId={w.id} />}</div>}
      {w.kind === 'ticket' && (w.category === 'Todo' || w.category === 'Active') && <ReplyHelper key={w.id} w={w} onPosted={refetch} />}
      <Activity w={w} onPosted={refetch} />
      <p className="wkp-foot">Changes save as you go · Time, files and history live in this one stream.</p>
    </div>
  );
}

function Tile({ label, value, tone, disabled, children }: { label: string; value: ReactNode; tone?: 'late' | 'done' | 'active'; disabled?: boolean; children: ReactNode }) {
  return (
    <label className={`wkp-tile ${tone ?? ''} ${disabled ? 'ro' : ''}`}>
      <span className="wkp-tile-l">{label}</span>
      <b className="wkp-tile-v">{value}</b>
      {children}
    </label>
  );
}

function DueReason({ from, to, onCancel, onSave }: { from: string | null; to: string | null; onCancel: () => void; onSave: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const days = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) : null;
  return (
    <form className="wkp-due-ask" onSubmit={(e) => { e.preventDefault(); if (!reason.trim()) return; setBusy(true); void onSave(reason.trim()).finally(() => setBusy(false)); }}>
      <span>Due moves from <s>{formatDate(from)}</s> to <b>{to ? formatDate(to) : 'no date'}</b>{days ? ` (+${days} day${days === 1 ? '' : 's'})` : ''}. Why?</span>
      <input autoFocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Waiting for the client's sign-off" aria-label="Reason for moving the due date" />
      <div className="wkp-due-acts">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Keep the date</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !reason.trim()}>{busy ? 'Saving…' : 'Move it'}</button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ ✦ Copilot: one suggested action

interface Suggestion { id: string; text: string; label: string; run: () => void | Promise<unknown> }

function Copilot({ w, me, save, onDueAsk, onStatus, statuses, refetch }: {
  w: WorkItemDetail; me: string | null; save: (f: Omit<WorkItemPatch, 'version'>) => Promise<boolean>; onDueAsk: (to: string) => void; onStatus: (v: string) => void;
  statuses: { id: string; label: string }[]; refetch: () => void;
}) {
  const ai = useAi();
  const show = useCopilot((s) => s.show);
  const nav = useNavigate();
  const { pathname, search } = useLocation();
  const [busy, setBusy] = useState(false);
  const [, bump] = useState(0);
  const ask = (q: string) => { show(null); nav(`${pathname}${search}`, { state: { ask: q, ts: Date.now() } }); };
  const open = w.category === 'Todo' || w.category === 'Active';
  const comments = w.activity.filter((a) => a.type === 'comment').length;
  const editable = canEditOf(w);
  const nextDay = () => { let d = dateOffset(1); const day = new Date(`${d}T00:00:00`).getDay(); if (day === 6) d = dateOffset(3); else if (day === 0) d = dateOffset(2); return d; };
  const activeStatus = w.kind === 'task' ? statuses.find((s) => /progress|doing|active/i.test(s.label))?.id : 'InProgress';

  // An urgent ticket is fixed or escalated, never quietly given a later date: moving the due date of an outage hides it instead of solving it.
  const urgentTicket = w.kind === 'ticket' && open && (w.priority === 'Critical' || w.priority === 'High');
  let s: Suggestion | null = null;
  if (open && editable && !w.assignee && me) s = { id: 'own', text: 'Nobody owns this yet. Work without an owner tends to wait.', label: 'Take it', run: () => save({ assigneeId: me }) };
  else if (urgentTicket && ai && w.isOverdue && w.dueDate) {
    const late = Math.abs(daysUntil(w.dueDate) ?? 0);
    s = { id: 'escalate', text: `${w.priority} and ${late === 0 ? 'past its target today' : `${late} day${late === 1 ? '' : 's'} past its target`}. Escalate it and send a status update.`, label: 'Draft escalation',
      run: () => ask(`Ticket ${w.key} "${w.title}" is ${w.priority} and past its target${w.assignee ? ` (owner ${w.assignee.name})` : ''}. Draft a short escalation to the on-call lead and a status update for the people affected, and list the next fix steps from similar tickets or runbooks.${w.description ? `\n\nDetails: ${w.description.slice(0, 600)}` : ''}`) };
  }
  else if (open && editable && w.isOverdue && w.dueDate && !urgentTicket) {
    const to = nextDay(), late = Math.abs(daysUntil(w.dueDate) ?? 0);
    s = { id: 'late', text: `This is ${late} day${late === 1 ? '' : 's'} late. If it still matters, give it a date it can meet.`, label: `Move to ${formatDate(to).slice(0, 6)}`,
      run: () => (w.kind === 'task' ? onDueAsk(to) : save({ dueDate: to })) };
  }
  else if (w.kind === 'ticket' && open && ai && (w.priority === 'Critical' || w.priority === 'High') && comments === 0)
    s = { id: 'reply', text: `${w.priority} and nobody has answered yet. I can draft a first reply from similar tickets.`, label: 'Draft a reply',
      run: () => ask(`Draft a short first reply for ticket ${w.key} "${w.title}". Use what fixed similar tickets before, if any.${w.description ? `\n\nDetails: ${w.description.slice(0, 600)}` : ''}`) };
  else if (w.category === 'Todo' && editable && w.dueDate && (daysUntil(w.dueDate) ?? 9) <= 1 && activeStatus)
    s = { id: 'start', text: `Due ${dueText(w.dueDate, false).toLowerCase()} and not started.`, label: 'Start it', run: () => onStatus(activeStatus) };
  else if (w.category === 'Active' && (w.kind === 'task' || w.kind === 'ticket') && w.loggedMinutes === 0 && editable)
    s = { id: 'log', text: 'In progress, but no time is logged on it yet.', label: 'Log 1h',
      run: async () => { const r = await workItemsApi.comment(w.id, 'log 1h'); if (r.time) toast('Logged 1h.'); else if (r.timeProblem) toast(r.timeProblem, 'info'); refetch(); } };
  else if (ai) s = { id: 'ask', text: `Ask what is blocking ${w.key}, what changed, or what to do next.`, label: 'Ask about it',
    run: () => ask(`Summarise ${KIND_LONG[w.kind].toLowerCase()} ${w.key} "${w.title}" (status ${w.status}, priority ${w.priority}${w.assignee ? `, owner ${w.assignee.name}` : ''}) and suggest the next step.`) };
  if (!s || dismissed.has(`${w.id}:${s.id}`)) return null;
  const sug = s;
  return (
    <AiCard stacked title="Copilot" className="wkp-ai" dismissLabel="Not now" onDismiss={() => { dismissed.add(`${w.id}:${sug.id}`); bump((n) => n + 1); }}
      action={{ label: sug.label, busy, onClick: () => { setBusy(true); void Promise.resolve(sug.run()).finally(() => setBusy(false)); } }}>
      {sug.text}
    </AiCard>
  );
}

// ------------------------------------------------------------------ a ticket's own fields

/** "8:30 am" today, "Tue 8:30 am" this week, else the date and time. */
function fixBy(iso: string) {
  const d = new Date(iso), days = (d.getTime() - Date.now()) / 86_400_000;
  if (new Date().toDateString() === d.toDateString()) return formatTime(iso);
  if (days > 0 && days < 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${formatTime(iso)}`;
  return formatDateTime(iso);
}

const CHANNEL_LABEL: Record<string, string> = { app: 'In the app', email: 'E-mail', whatsapp: 'WhatsApp', phone: 'Phone call', webhook: 'Webhook', ai: 'Assistant' };

function TicketFields({ w, editable, save }: { w: WorkItemDetail; editable: boolean; save: (f: Omit<WorkItemPatch, 'version'>) => Promise<boolean> }) {
  const d = w.detail as { sla?: WorkSla | null; workTypeId?: string; workType?: string; relatedProject?: { id: string; name: string } | null };
  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true), { staleTime: 5 * 60_000 });
  const projects = useWsQuery(['projects', 'work-picker'], () => projectApi.list({ pageSize: 200, includeArchived: true, sort: 'name' }), { staleTime: 5 * 60_000 });
  const channel = w.channel ?? 'app';
  const sla = d.sla ?? null;
  return (
    <dl className="wkp-fields">
      <div><dt>SLA</dt><dd>{sla ? <span className="wkp-sla"><SlaChip sla={sla} />{sla.resolution && <small>fix by {fixBy(sla.resolution.dueAt)}</small>}</span> : <span className="muted">No target for this type and priority</span>}</dd></div>
      <div><dt>Channel</dt><dd><span className={`wkp-channel c-${channel}`}>{CHANNEL_LABEL[channel] ?? channel}</span></dd></div>
      <div><dt>Type</dt><dd className="wkp-inline">
        <span>{d.workType ?? '—'}</span>
        {editable && <select aria-label="Work type" value={d.workTypeId ?? ''} onChange={(e) => void save({ workTypeId: e.target.value })}>
          {(types.data ?? []).filter((t) => t.isActive || t.id === d.workTypeId).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>}
      </dd></div>
      <div><dt>Project</dt><dd className="wkp-inline">
        <span>{d.relatedProject?.name ?? 'None'}</span>
        {editable && <select aria-label="Related project" value={d.relatedProject?.id ?? ''} onChange={(e) => void save({ projectId: e.target.value || null })}>
          <option value="">None</option>{(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
        </select>}
      </dd></div>
      {w.loggedMinutes > 0 && <div><dt>Time logged</dt><dd>{formatMinutes(w.loggedMinutes)}</dd></div>}
      <div className="wkp-res"><dt>Resolution</dt><dd><Resolution id={w.id} done={w.category === 'Done'} /></dd></div>
    </dl>
  );
}

function Resolution({ id, done }: { id: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wkp-resolution">
      <button type="button" className="wkp-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : done ? 'Record or check the verified fix' : 'After it is completed'} <Icon name="chevronD" size={12} />
      </button>
      {open && <div className="wkp-resolution-body"><SupportResolution taskId={id} onChanged={() => undefined} /></div>}
    </div>
  );
}

// ------------------------------------------------------------------ description and files

function Description({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => Promise<boolean> }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.max(64, el.scrollHeight)}px`; } }, [v]);
  if (disabled && !value) return null;
  return (
    <div className="wkp-section">
      <h3 className="wkp-h">Details</h3>
      <textarea ref={ref} className="wkp-desc" value={v} disabled={disabled} maxLength={8000} placeholder="Add details: what happened, what is needed…" aria-label="Details"
        onChange={(e) => setV(e.target.value)} onBlur={() => { if (v.trim() !== value.trim()) void onSave(v.trim()); }} />
    </div>
  );
}

function Files({ w, editable, onAdded }: { w: WorkItemDetail; editable: boolean; onAdded: () => void }) {
  const files = w.activity.filter((a) => a.type === 'file' && a.fileId);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const path = w.kind === 'ticket' ? `/work-tasks/${w.id}/attachments` : w.kind === 'task' && w.projectId ? `/projects/${w.projectId}/tasks/${w.id}/attachments`
    : w.kind === 'issue' && w.projectId ? `/projects/${w.projectId}/issues/${w.id}/attachments` : null;
  const upload = async (file: File | undefined) => {
    if (!file || !path) return;
    setBusy(true);
    try { await uploadFile(path, file); toast(`${file.name} added.`); onAdded(); }
    catch (e) { toast(errText(e, 'Could not add the file.'), 'error'); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const get = (f: WorkActivity) => void download(w.kind === 'ticket' ? `/work-attachments/${f.fileId}/download` : `/attachments/${f.fileId}/download`, f.fileName ?? 'file')
    .catch((e) => toast(errText(e, 'Could not download the file.'), 'error'));
  if (files.length === 0 && (!path || !editable)) return null;
  return (
    <div className="wkp-section">
      <h3 className="wkp-h">Files{files.length > 0 && <em>{files.length}</em>}</h3>
      <div className="wkp-files">
        {files.map((f) => <button key={f.id} type="button" className="wkp-file" onClick={() => get(f)} title={`Download ${f.fileName}`}><Icon name="paperclip" size={13} /><span>{f.fileName}</span></button>)}
        {path && editable && (
          <>
            <input ref={input} type="file" hidden onChange={(e) => void upload(e.target.files?.[0])} aria-label="Choose a file" data-testid="wkp-file-input" />
            <button type="button" className="wkp-file add" disabled={busy} onClick={() => input.current?.click()}><Icon name={busy ? 'clock' : 'plus'} size={13} /><span>{busy ? 'Adding…' : 'Add a file'}</span></button>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the one Activity stream

const SHOWN = 8;

function Activity({ w, onPosted }: { w: WorkItemDetail; onPosted: () => void }) {
  const [all, setAll] = useState(false);
  useEffect(() => { setAll(false); }, [w.id]);
  const rows = useMemo(() => [...w.activity].reverse(), [w.activity]);   // oldest first; the newest sits by the comment box
  const hidden = all ? 0 : Math.max(0, rows.length - SHOWN);
  return (
    <section className="wkp-section" aria-label="Activity">
      <h3 className="wkp-h">Activity</h3>
      {rows.length === 0 ? <p className="wkp-empty">Nothing yet. Comments, time, files and changes appear here.</p> : (
        <ol className="wkp-stream">
          {hidden > 0 && <li><button type="button" className="wkp-link" onClick={() => setAll(true)}>Show {hidden} earlier</button></li>}
          {rows.slice(hidden).map((a) => <ActivityRow key={`${a.type}:${a.id}`} a={a} />)}
        </ol>
      )}
      <Composer w={w} onPosted={onPosted} />
    </section>
  );
}

const ACT_ICON = { comment: 'message', time: 'clock', file: 'paperclip', change: 'activity', ai: 'sparkle' } as const;

function ActivityRow({ a }: { a: WorkActivity }) {
  const who = a.type === 'ai' ? (a.auto ? 'Copilot' : 'Copilot') : a.actor?.name || 'Someone';
  const text = a.type === 'comment' ? 'commented' : a.summary;
  return (
    <li className={`wkp-act t-${a.type}`}>
      <span className="wkp-act-ico" aria-hidden="true"><Icon name={ACT_ICON[a.type]} size={13} /></span>
      <div className="wkp-act-main">
        <p><b>{who}</b> {text}{a.type === 'ai' && a.actor?.name && !a.auto ? <span className="muted"> · approved by {a.actor.name}</span> : null}
          <time dateTime={a.at} title={formatDateTime(a.at)}> · {ago(a.at)}</time></p>
        {a.type === 'comment' && a.body && <div className="wkp-bubble">{a.body}</div>}
        {a.type === 'time' && a.body && <div className="wkp-note">{a.body}</div>}
        {a.type === 'ai' && a.body && <div className="wkp-note">{a.body}</div>}
      </div>
    </li>
  );
}

function Composer({ w, onPosted }: { w: WorkItemDetail; onPosted: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const wid = useWorkspaceId();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setBody(''); setNote(null); }, [w.id]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(160, el.scrollHeight)}px`; } }, [body]);
  const logs = /^\s*\/?log\s+/i.test(body);
  const send = async () => {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true); setNote(null);
    try {
      const r = await workItemsApi.comment(w.id, text);
      setBody('');
      if (r.time) toast(`Logged ${formatMinutes(r.time.minutes ?? 0)} on ${w.key}.`);
      if (r.timeProblem) setNote(r.timeProblem);
      onPosted();
      refreshWork(wid);
    } catch (e) { toast(errText(e, 'Could not post the comment.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="wkp-compose">
      <div className={`wkp-compose-box ${logs ? 'logs' : ''}`}>
        <textarea ref={ref} rows={1} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="Comment, or “log 2h”…" aria-label="Comment, or log time"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <button type="button" className="wkp-send" aria-label={logs ? 'Log time' : 'Post comment'} disabled={!body.trim() || busy} onClick={() => void send()}><Icon name={logs ? 'clock' : 'arrowUp'} size={15} /></button>
      </div>
      {logs && !note && <p className="wkp-hint">{w.kind === 'task' || w.kind === 'ticket' ? 'Logs this time on it, as you, and posts the comment.' : 'Time is logged on tasks and tickets; this posts as a comment.'}</p>}
      {note && <p className="wkp-hint warn" role="status">{note}</p>}
    </div>
  );
}

