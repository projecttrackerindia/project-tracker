import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { workApi, workspaceApi } from '../../api/endpoints';
import type { Priority } from '../../api/types';
import { Icon, type IconName } from '../Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { parseQuickTask, type QuickPerson } from '../../lib/quickTask';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { openReminderComposer } from '../../features/reminders/store';
import { guessType, useNewSheet, type NewType } from './state';
import './v2.css';

const TaskModal = lazy(() => import('../../features/tasks/TaskModal').then((m) => ({ default: m.TaskModal })));
const ProjectFormModal = lazy(() => import('../../features/projects/ProjectFormModal').then((m) => ({ default: m.ProjectFormModal })));

const TYPES: { id: NewType; label: string; icon: IconName }[] = [
  { id: 'task', label: 'Task', icon: 'check' }, { id: 'ticket', label: 'Ticket', icon: 'bolt' }, { id: 'project', label: 'Project', icon: 'folder' },
  { id: 'doc', label: 'Doc', icon: 'note' }, { id: 'secret', label: 'Secret', icon: 'key' }, { id: 'meeting', label: 'Meeting', icon: 'video' },
  { id: 'reminder', label: 'Reminder', icon: 'alarm' }, { id: 'time', label: 'Time', icon: 'clock' },
];
const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Critical'];

/** The sheet itself; mounted once in the layout. */
export function NewSheetHost() {
  const open = useNewSheet((s) => s.open);
  const [making, setMaking] = useState<{ kind: 'task' | 'project'; title: string; priority?: Priority; assigneeId?: string; dueDate?: string } | null>(null);
  const nav = useNavigate();
  return (
    <>
      {open && <NewSheet onMake={setMaking} />}
      <Suspense fallback={null}>
        {making?.kind === 'task' && <TaskModal initial={{ title: making.title, priority: making.priority, assigneeId: making.assigneeId, dueDate: making.dueDate }} onClose={() => setMaking(null)} />}
        {making?.kind === 'project' && <ProjectFormModal onClose={() => setMaking(null)} onSaved={(id: string) => { setMaking(null); nav(`/work/projects/${id}`); }} />}
      </Suspense>
    </>
  );
}

function NewSheet({ onMake }: { onMake: (m: { kind: 'task' | 'project'; title: string; priority?: Priority; assigneeId?: string; dueDate?: string }) => void }) {
  const { type: presetType, text: presetText, close } = useNewSheet();
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user);
  const role = useAuth((s) => s.ctx?.current?.role);
  const [mTasks, mProjects, mWork, mDocs] = [useModule('tasks'), useModule('projects'), useModule('work'), useModule('documents')];
  const [cTask, cProject, cWork, cVault] = [useCan('tasks.create'), useCan('projects.create'), useCan('work.create'), useCan('vault.use')];
  const allowed = (t: NewType) => ({
    task: cTask && mTasks > 0 && mProjects > 0, ticket: cWork && mWork >= 2, project: cProject && mProjects >= 2, doc: mDocs > 0,
    secret: cVault && role !== 'Guest', meeting: true, reminder: true, time: mTasks > 0 || mWork > 0,
  })[t];

  const [text, setText] = useState(presetText);
  const [picked, setPicked] = useState<NewType | null>(presetType && allowed(presetType) ? presetType : null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [workTypeId, setWorkTypeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { setTimeout(() => input.current?.focus(), 20); }, []);

  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000 });
  const people: QuickPerson[] = useMemo(() => (members.data ?? []).map((m) => ({ id: m.userId, name: m.displayName })), [members.data]);
  const mePerson = me ? { id: me.id, name: me.displayName } : undefined;
  const parsed = useMemo(() => parseQuickTask(text.replace(/\b(?:give|hand|pass)\s+(?:it\s+)?to\b|\bowner:?(?=\s)/gi, 'assign to'), people, new Date(), mePerson), [text, people, mePerson?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const guessed = useMemo(() => guessType(text, allowed), [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = picked ?? guessed;
  const types = useWsQuery(['work', 'types'], () => workApi.types(), { enabled: type === 'ticket', staleTime: 5 * 60_000 });
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  // A ticket's type from its words ("bug", "access"…), else the first active type.
  const wordType = activeTypes.find((t) => text.toLowerCase().includes(t.name.toLowerCase().replace(/s$/, ''))) ?? activeTypes[0];
  const chosenType = activeTypes.find((t) => t.id === workTypeId) ?? wordType;
  const pr: Priority = priority ?? parsed.priority ?? 'Medium';
  const owner = ownerId === '' ? null : people.find((p) => p.id === (ownerId ?? parsed.assignee?.id)) ?? null;
  const title = (parsed.title || text).trim();
  const label = TYPES.find((t) => t.id === type)?.label ?? '';

  const createIt = async () => {
    if (!type || busy) return;
    const words = text.trim();
    const q = (k: string, v: string) => (v ? `${k}=${encodeURIComponent(v)}` : '');
    const join = (base: string, ...parts: string[]) => { const s = parts.filter(Boolean).join('&'); return s ? `${base}${base.includes('?') ? '&' : '?'}${s}` : base; };
    switch (type) {
      case 'task': close(); onMake({ kind: 'task', title, priority: pr, assigneeId: owner?.id, dueDate: parsed.dueDate }); return;
      case 'project': close(); onMake({ kind: 'project', title }); return;
      case 'reminder': close(); openReminderComposer({ text: words }); return;
      case 'doc': close(); nav(join('/library/docs?new=1', q('title', title))); return;
      case 'secret': close(); nav(join('/library/vault?new=item', q('title', title))); return;
      case 'meeting': close(); nav(join('/talk?f=meetings&new=schedule', q('title', title))); return;
      case 'time': close(); nav(join('/insights?tab=time', q('log', words))); return;
      case 'ticket': {
        if (!title) { input.current?.focus(); return; }
        if (!chosenType) { toast('Add a work type first (Settings › Fields & types).', 'error'); return; }
        setBusy(true);
        try {
          const t = await workApi.create({ title, description: null, workTypeId: chosenType.id, assigneeId: owner?.id ?? null, priority: pr, status: 'ToDo', dueDate: parsed.dueDate ?? null });
          void invalidateWorkspace(wid, 'work');
          close();
          toast(`${t.key} created.`, 'success', { label: 'Open', onClick: () => nav(`/work?tab=tickets&item=${t.id}`) });
        } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not create the ticket.', 'error'); }
        finally { setBusy(false); }
      }
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void createIt(); }
    else if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); void createIt(); }
  };
  const goes = type === 'doc' ? 'Opens Library to write it.' : type === 'secret' ? 'Opens the Vault to fill in the secret.' : type === 'meeting' ? 'Opens the meeting form in Talk.'
    : type === 'time' ? 'Opens your timesheet with this entry.' : type === 'project' ? 'Opens the project form.' : type === 'reminder' ? 'Opens the reminder with the time it understood.'
    : type === 'task' ? 'Opens the task to pick its project.' : 'Tap any chip to change it. Everything else can be added later.';

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
            <span className="v2-understood-label">✦ I understood this as a {label.toLowerCase()}</span>
            <h3 className={title ? '' : 'empty'}>{title || 'Type what it is above'}</h3>
            {(type === 'ticket' || type === 'task') && (
              <div className="v2-new-chips">
                <span className="v2-new-chip">Type <b>{type === 'ticket' ? chosenType?.name ?? '—' : 'Task'}</b>
                  {type === 'ticket' && activeTypes.length > 1 && <select aria-label="Type" value={chosenType?.id ?? ''} onChange={(e) => setWorkTypeId(e.target.value)}>{activeTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
                  {type === 'task' && <select aria-label="Type" value="task" onChange={(e) => setPicked(e.target.value as NewType)}><option value="task">Task</option>{allowed('ticket') && <option value="ticket">Ticket</option>}</select>}
                </span>
                <span className="v2-new-chip">Priority <b>{pr}</b><select aria-label="Priority" value={pr} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></span>
                <span className="v2-new-chip">Owner <b>{owner?.name ?? 'Nobody yet'}</b>
                  <select aria-label="Owner" value={owner?.id ?? ''} onChange={(e) => setOwnerId(e.target.value)}><option value="">Nobody yet</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></span>
                {parsed.dueDate && <span className="v2-new-chip">Due <b>{parsed.dueLabel ?? parsed.dueDate}</b></span>}
              </div>
            )}
            <p>{goes}</p>
          </div>
        )}
        <div className="v2-new-foot">
          <span>⌘↵ to create · Esc to close</span>
          <button type="button" className="btn btn-primary" disabled={!type || busy || (!title && type !== 'reminder' && type !== 'time')} onClick={() => void createIt()}>
            {busy ? 'Creating…' : type ? `Create ${label.toLowerCase()}` : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
