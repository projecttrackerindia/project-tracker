import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, workApi, workspaceApi } from '../../api/endpoints';
import type { Priority } from '../../api/types';
import { workItemsApi, type WorkKind } from '../../api/workItemsApi';
import { Icon, type IconName } from '../Icon';
import { useWsQuery } from '../../lib/hooks';
import { parseQuickTask, type QuickPerson } from '../../lib/quickTask';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { openReminderComposer } from '../../features/reminders/store';
import { panelHosts, refreshWork } from '../../features/work/workUi';
import { guessType, useNewSheet, type NewType } from './state';
import './v2.css';

const ProjectFormModal = lazy(() => import('../../features/projects/ProjectFormModal').then((m) => ({ default: m.ProjectFormModal })));

const TYPES: { id: NewType; label: string; icon: IconName }[] = [
  { id: 'task', label: 'Task', icon: 'check' }, { id: 'ticket', label: 'Ticket', icon: 'bolt' }, { id: 'project', label: 'Project', icon: 'folder' },
  { id: 'doc', label: 'Doc', icon: 'note' }, { id: 'secret', label: 'Secret', icon: 'key' }, { id: 'meeting', label: 'Meeting', icon: 'video' },
  { id: 'reminder', label: 'Reminder', icon: 'alarm' }, { id: 'time', label: 'Time', icon: 'clock' },
];
const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low'];
/** Project work: the Task tile makes a task, an issue or an action item (the Type chip). */
type ProjectKind = 'task' | 'issue' | 'action';
const PROJECT_KINDS: { id: ProjectKind; label: string }[] = [{ id: 'task', label: 'Task' }, { id: 'issue', label: 'Issue' }, { id: 'action', label: 'Action item' }];
const LAST_PROJECT = 'pm_new_last_project';
const readLast = () => { try { return localStorage.getItem(LAST_PROJECT); } catch { return null; } };
const writeLast = (id: string) => { try { localStorage.setItem(LAST_PROJECT, id); } catch { /* private window */ } };
/** A service-level target in words: 240 → "4 hours", 1440 → "1 day", 2160 → "1d 12h", 30 → "30 min". */
const spell = (min: number) => {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min < 1440 && min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  if (min < 60) return `${min} min`;
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ');
};

/** The sheet itself; mounted once in the layout. */
export function NewSheetHost() {
  const open = useNewSheet((s) => s.open);
  const [making, setMaking] = useState<'project' | null>(null);
  const nav = useNavigate();
  return (
    <>
      {open && <NewSheet onProject={() => setMaking('project')} />}
      <Suspense fallback={null}>
        {making === 'project' && <ProjectFormModal onClose={() => setMaking(null)} onSaved={(id: string) => { setMaking(null); nav(`/work/projects/${id}`); }} />}
      </Suspense>
    </>
  );
}

/**
 * + New (V2-SPEC §3.11): one sheet for the eight things. You type a sentence; it says what it understood ("I understood this as a ticket")
 * with chips for type, priority, owner and SLA (or project and due date for project work), each changed by tapping it. Tasks, issues,
 * action items and tickets are made here at once (POST /work-items) and open in the Work side panel; the other types open where they are
 * written, with the words carried over.
 */
function NewSheet({ onProject }: { onProject: () => void }) {
  const { type: presetType, text: presetText, context, close } = useNewSheet();
  const nav = useNavigate();
  const loc = useLocation();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user);
  const role = useAuth((s) => s.ctx?.current?.role);
  const [mTasks, mProjects, mWork, mDocs] = [useModule('tasks'), useModule('projects'), useModule('work'), useModule('documents')];
  const [cTask, cProject, cWork, cVault, cComment] = [useCan('tasks.create'), useCan('projects.create'), useCan('work.create'), useCan('vault.use'), useCan('tasks.comment')];
  const allowed = (t: NewType) => ({
    task: (cTask || cComment) && mTasks > 0 && mProjects > 0, ticket: cWork && mWork >= 2, project: cProject && mProjects >= 2, doc: mDocs > 0,
    secret: cVault && role !== 'Guest', meeting: true, reminder: true, time: mTasks > 0 || mWork > 0,
  })[t];
  const kindAllowed = (k: ProjectKind) => (k === 'task' ? cTask && mTasks > 0 : k === 'issue' ? cComment && mTasks > 0 && mProjects > 0 : mProjects >= 2);

  const [text, setText] = useState(presetText);
  const [picked, setPicked] = useState<NewType | null>(presetType && allowed(presetType) ? presetType : null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [workTypeId, setWorkTypeId] = useState<string | null>(null);
  const [kind, setKind] = useState<ProjectKind | null>(context.kind ?? null);
  const pathProject = /^\/work\/projects\/([0-9a-f-]{8,})/i.exec(loc.pathname)?.[1] ?? null;
  const [projectId, setProjectId] = useState<string | null>(context.projectId ?? pathProject);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => input.current?.focus(), 20); }, []);

  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000 });
  const people: QuickPerson[] = useMemo(() => (members.data ?? []).filter((m) => m.role !== 'Guest').map((m) => ({ id: m.userId, name: m.displayName })), [members.data]);
  const mePerson = me ? { id: me.id, name: me.displayName } : undefined;
  const parsed = useMemo(() => parseQuickTask(text.replace(/\b(?:give|hand|pass)\s+(?:it\s+)?to\b|\bowner:?(?=\s)/gi, 'assign to'), people, new Date(), mePerson), [text, people, mePerson?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const guessed = useMemo(() => guessType(text, allowed), [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = picked ?? guessed;
  const work = type === 'task' || type === 'ticket';

  const types = useWsQuery(['work', 'types'], () => workApi.types(), { enabled: type === 'ticket', staleTime: 5 * 60_000 });
  const sla = useWsQuery(['work', 'sla'], workApi.sla, { enabled: type === 'ticket', staleTime: 5 * 60_000, retry: false });
  const projects = useWsQuery(['projects', 'new-sheet'], () => projectApi.list({ pageSize: 200, sort: 'name' }), { enabled: work, staleTime: 60_000 });
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  // A ticket's type from its words ("bug", "access"…), else the first active type.
  const wordType = activeTypes.find((t) => text.toLowerCase().includes(t.name.toLowerCase().replace(/s$/, ''))) ?? activeTypes[0];
  const chosenType = activeTypes.find((t) => t.id === workTypeId) ?? wordType;
  const pr: Priority = priority ?? parsed.priority ?? 'Medium';
  const owner = ownerId === '' ? null : people.find((p) => p.id === (ownerId ?? parsed.assignee?.id)) ?? null;
  const title = (parsed.title || text).trim();
  const label = TYPES.find((t) => t.id === type)?.label ?? '';

  // Project work belongs to a project: the one asked for, the page's, one named in the words, else the last one used.
  const live = (projects.data?.items ?? []).filter((p) => p.status !== 'Archived' && p.status !== 'Cancelled');
  const named = useMemo(() => { const t = ` ${text.toLowerCase()} `; return live.find((p) => t.includes(` ${p.key.toLowerCase()} `) || (p.name.length > 3 && t.includes(p.name.toLowerCase()))); }, [text, live]);
  const project = live.find((p) => p.id === projectId) ?? named ?? live.find((p) => p.id === readLast()) ?? null;
  const pkind: ProjectKind = kind && kindAllowed(kind) ? kind : PROJECT_KINDS.find((k) => kindAllowed(k.id))?.id ?? 'task';
  const pkLabel = PROJECT_KINDS.find((k) => k.id === pkind)!.label;
  // The service level this ticket will get: its type's own targets, else the workspace's, for the priority.
  const levels = Array.isArray(sla.data?.defaults) ? sla.data! : null;
  const targets = levels ? (levels.overrides?.find((o) => o.workTypeId === chosenType?.id)?.targets ?? levels.defaults) : [];
  const slaOf = (p: Priority) => targets.find((t) => t.priority === p)?.resolutionMinutes ?? null;
  const shownLabel = type === 'task' ? pkLabel.toLowerCase() : label.toLowerCase();

  /** Opens what was just made in the Work side panel: here, when this page shows one for its project; otherwise on Work. */
  const openMade = (id: string, inProject: string | null) => {
    if (inProject && pathProject === inProject && panelHosts.has(`project:${inProject}`)) {
      const n = new URLSearchParams(loc.search); n.set('item', id); nav(`${loc.pathname}?${n}`); return;
    }
    if (loc.pathname === '/work') { const n = new URLSearchParams(loc.search); n.set('item', id); nav(`/work?${n}`); return; }
    nav(`/work?item=${id}`);
  };

  const makeWork = async () => {
    if (!title) { input.current?.focus(); return; }
    let k: WorkKind;
    const body: Parameters<typeof workItemsApi.create>[0] = { kind: 'task', title, priority: pr, assigneeId: owner?.id ?? null, dueDate: parsed.dueDate ?? null };
    if (type === 'ticket') {
      if (!chosenType) { toast('Add a work type first (Settings › Fields & types).', 'error'); return; }
      k = 'ticket'; Object.assign(body, { kind: 'ticket', workTypeId: chosenType.id, projectId: projectId ?? null });
    } else {
      if (!project) { toast('Choose the project it belongs to.', 'error'); return; }
      k = pkind; Object.assign(body, { kind: pkind, projectId: project.id, estimatedHours: pkind === 'task' ? parsed.estimatedHours ?? null : undefined });
      writeLast(project.id);
    }
    setBusy(true);
    try {
      const made = await workItemsApi.create(body);
      refreshWork(wid);
      close();
      toast(`${made.key} created.`);
      openMade(made.id, k === 'ticket' ? null : made.projectId);
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : `Could not create the ${shownLabel}.`, 'error'); }
    finally { setBusy(false); }
  };

  const createIt = async () => {
    if (!type || busy) return;
    const words = text.trim();
    const q = (k: string, v: string) => (v ? `${k}=${encodeURIComponent(v)}` : '');
    const join = (base: string, ...parts: string[]) => { const s = parts.filter(Boolean).join('&'); return s ? `${base}${base.includes('?') ? '&' : '?'}${s}` : base; };
    switch (type) {
      case 'task': case 'ticket': await makeWork(); return;
      case 'project': close(); onProject(); return;
      case 'reminder': close(); openReminderComposer({ text: words }); return;
      case 'doc': close(); nav(join('/library/docs?new=1', q('title', title))); return;
      case 'secret': close(); nav(join('/library/vault?new=item', q('title', title))); return;
      case 'meeting': close(); nav(join('/talk?f=meetings&new=schedule', q('title', title))); return;
      case 'time': close(); nav(join('/insights?tab=time', q('log', words))); return;
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void createIt(); }
    else if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); void createIt(); }
  };
  const goes = type === 'doc' ? 'Opens Library to write it.' : type === 'secret' ? 'Opens the Vault to fill in the secret.' : type === 'meeting' ? 'Opens the meeting form in Talk.'
    : type === 'time' ? 'Opens your timesheet with this entry.' : type === 'project' ? 'Opens the project form.' : type === 'reminder' ? 'Opens the reminder with the time it understood.'
    : type === 'task' && !project ? 'Pick the project it belongs to.' : 'Tap any chip to change it. Everything else can be added later.';
  const blocked = !type || busy || (!title && type !== 'reminder' && type !== 'time') || (type === 'task' && !project) || (type === 'ticket' && !chosenType && types.isSuccess);

  return (
    <div className="v2-new-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="v2-new-sheet" role="dialog" aria-modal="true" aria-labelledby="v2-new-title" onKeyDown={onKey}>
        <div className="v2-new-head"><h2 id="v2-new-title">New</h2>
          <button type="button" className="v2-panel-close" aria-label="Close" onClick={close}><Icon name="close" size={16} /></button></div>
        <label className="v2-new-input">
          <span className="v2-spark" aria-hidden="true">✦</span>
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Say what it is: “VPN down for collections, critical, give to Priya”" aria-label="What to create" />
        </label>
        <div className="v2-new-types" role="radiogroup" aria-label="Type">
          {TYPES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={type === t.id} className={`v2-new-type ${type === t.id ? 'on' : ''}`} disabled={!allowed(t.id)}
              onClick={() => { setPicked(t.id); input.current?.focus(); }}>
              <Icon name={t.icon} size={18} />{t.label}
            </button>
          ))}
        </div>
        {type && (
          <div className="v2-understood" aria-live="polite">
            <span className="v2-understood-label">✦ I understood this as {/^[aeiou]/.test(shownLabel) ? 'an' : 'a'} {shownLabel}</span>
            <h3 className={title ? '' : 'empty'}>{title || 'Type what it is above'}</h3>
            {work && (
              <div className="v2-new-chips">
                {type === 'ticket' ? (
                  <Chip label="Type" value={chosenType?.name ?? '—'}>
                    {activeTypes.length > 0 && <select aria-label="Change type" value={chosenType?.id ?? ''} onChange={(e) => setWorkTypeId(e.target.value)}>{activeTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
                  </Chip>
                ) : (
                  <Chip label="Type" value={pkLabel}>
                    <select aria-label="Change type" value={pkind} onChange={(e) => { if (e.target.value === 'ticket') setPicked('ticket'); else setKind(e.target.value as ProjectKind); }}>
                      {PROJECT_KINDS.filter((k) => kindAllowed(k.id)).map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                      {allowed('ticket') && <option value="ticket">Ticket</option>}
                    </select>
                  </Chip>
                )}
                <Chip label="Priority" value={pr}><select aria-label="Change priority" value={pr} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Chip>
                <Chip label="Owner" value={owner?.name ?? 'Nobody yet'}>
                  <select aria-label="Change owner" value={owner?.id ?? ''} onChange={(e) => setOwnerId(e.target.value)}><option value="">Nobody yet</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me?.id ? ' (you)' : ''}</option>)}</select>
                </Chip>
                {type === 'ticket' && targets.length > 0 && (
                  <Chip label="SLA" value={slaOf(pr) ? spell(slaOf(pr)!) : 'None'} title="The time to fix it, from the service levels for this type and priority. Choosing one sets the priority.">
                    <select aria-label="Change SLA" value={pr} onChange={(e) => setPriority(e.target.value as Priority)}>
                      {PRIORITIES.map((p) => <option key={p} value={p}>{slaOf(p) ? `${spell(slaOf(p)!)} (${p})` : `No target (${p})`}</option>)}
                    </select>
                  </Chip>
                )}
                {(type === 'task' || live.length > 0) && (
                  <Chip label="Project" value={type === 'task' ? project?.name ?? 'Choose…' : live.find((p) => p.id === projectId)?.name ?? 'None'} warn={type === 'task' && !project}>
                    <select aria-label="Change project" value={type === 'task' ? project?.id ?? '' : projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
                      <option value="" disabled={type === 'task'}>{type === 'task' ? 'Choose a project' : 'None'}</option>
                      {live.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
                    </select>
                  </Chip>
                )}
                {parsed.dueDate && <Chip label="Due" value={parsed.dueLabel ?? parsed.dueDate} />}
              </div>
            )}
            <p>{goes}</p>
          </div>
        )}
        <div className="v2-new-foot">
          <span>⌘↵ to create · Esc to close</span>
          <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => void createIt()}>
            {busy ? 'Creating…' : type ? `Create ${shownLabel}` : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A chip that says what was understood; tapping it opens its choices (a native picker over the chip, so phones show their own). */
function Chip({ label, value, warn, title, children }: { label: string; value: string; warn?: boolean; title?: string; children?: React.ReactNode }) {
  return <span className={`v2-new-chip ${warn ? 'warn' : ''} ${children ? 'tap' : ''}`} title={title}>{label} <b>{value}</b>{children}</span>;
}
