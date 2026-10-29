import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError, uploadFile } from '../../api/client';
import { attachmentApi, opsApi, projectApi, workApi, workspaceApi } from '../../api/endpoints';
import type { Priority } from '../../api/types';
import { workItemsApi, type WorkKind } from '../../api/workItemsApi';
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion';
import { spring } from '../../lib/motion';
import { conciseTitle, needsShortTitle, TITLE_MAX } from '../../lib/conciseTitle';
import { aiWorkspaceApi } from '../../features/ai/aiApi';
import { useAi } from '../../features/ai/Assistant';
import { useWsQuery } from '../../lib/hooks';
import { parseQuickTask, type QuickPerson } from '../../lib/quickTask';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { openReminderComposer } from '../../features/reminders/store';
import { panelHosts, refreshWork } from '../../features/work/workUi';
import { guessType, useNewSheet, type NewType } from './state';
import { openScheduleFromWords } from '../../features/meet/openFromWords';
import './v2.css';

const ProjectFormModal = lazy(() => import('../../features/projects/ProjectFormModal').then((m) => ({ default: m.ProjectFormModal })));

/** The eight kind tiles of the design (apple/s-new): glyph, colour, and the sidebar place each one lands in. Time stays reachable by words. */
const TYPES: { id: NewType; label: string; glyph: string; color: string; place: string; to: string; tile?: false }[] = [
  { id: 'task', label: 'Task', glyph: '✓', color: '#ff9500', place: 'My Work', to: '/work' },
  { id: 'ticket', label: 'Ticket', glyph: '◎', color: '#ff3b30', place: 'Desk', to: '/desk' },
  { id: 'bug', label: 'Bug', glyph: '✱', color: '#af52de', place: 'My Work', to: '/work' },
  { id: 'project', label: 'Project', glyph: '▤', color: '#5856d6', place: 'Projects', to: '/work/projects' },
  { id: 'doc', label: 'Doc', glyph: '✎', color: '#a2845e', place: 'Library', to: '/library' },
  { id: 'secret', label: 'Secret', glyph: '⚿', color: '#636366', place: 'Vault', to: '/library/vault' },
  { id: 'meeting', label: 'Meeting', glyph: '◫', color: '#30b0c7', place: 'Messages', to: '/messages' },
  { id: 'reminder', label: 'Reminder', glyph: '◔', color: '#ff9f0a', place: 'Today', to: '/' },
  { id: 'time', label: 'Time', glyph: '◷', color: '#34c759', place: 'Insights', to: '/insights', tile: false },
];
const PRIORITY_COLOR: Record<Priority, string> = { Critical: '#ff3b30', High: '#ff9500', Medium: '#0071e3', Low: '#8e8e93' };
const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
/** When the service level ends, in words: "today 2:00 PM", "tomorrow 9:30 AM", "Thu 30 Oct 2:00 PM". */
const whenIn = (min: number, now = new Date()) => {
  const d = new Date(now.getTime() + min * 60_000);
  const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  return diff === 0 ? `today ${t}` : diff === 1 ? `tomorrow ${t}` : `${d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })} ${t}`;
};
const PRIORITIES: Priority[] = ['Critical', 'High', 'Medium', 'Low'];
/** Project work: the Task tile makes a task, an issue or an action item (the Type chip). */
type ProjectKind = 'task' | 'issue' | 'action';
const PROJECT_KINDS: { id: ProjectKind; label: string }[] = [{ id: 'task', label: 'Task' }, { id: 'issue', label: 'Issue' }, { id: 'action', label: 'Action item' }];
const LAST_PROJECT = 'pm_new_last_project';
// Per workspace, so another workspace's project is never offered as the default.
const lastKey = () => `${LAST_PROJECT}:${useAuth.getState().ctx?.current?.id ?? ''}`;
const readLast = () => { try { return localStorage.getItem(lastKey()); } catch { return null; } };
const writeLast = (id: string) => { try { localStorage.setItem(lastKey(), id); } catch { /* private window */ } };
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
 * + New (apple/s-new): one sentence first ("Describe it…"); what it understood appears as chips one by one (kind · priority · person · place ·
 * due), each changed by tapping it, with a one-line reason; eight kind tiles with the guessed one highlighted; Attach,
 * Cancel and "Create <kind> ⌘↵" in the kind's colour. Tasks, bugs (project issues) and tickets are made here at once (POST /work-items):
 * the sheet shrinks into the matching sidebar item, whose badge bumps, and the item opens in the Work side panel. The other kinds open
 * where they are written, with the words carried over.
 */
function NewSheet({ onProject }: { onProject: () => void }) {
  const { type: presetType, text: presetText, project: inProject, close } = useNewSheet();
  const still = useReducedMotion();
  const nav = useNavigate();
  const loc = useLocation();
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx?.user);
  const role = useAuth((s) => s.ctx?.current?.role);
  const [mTasks, mProjects, mWork, mDocs] = [useModule('tasks'), useModule('projects'), useModule('work'), useModule('documents')];
  const [cTask, cProject, cWork, cVault, cComment] = [useCan('tasks.create'), useCan('projects.create'), useCan('work.create'), useCan('vault.use'), useCan('tasks.comment')];
  const allowed = (t: NewType) => ({
    task: (cTask || cComment) && mTasks > 0 && mProjects > 0, ticket: cWork && mWork >= 2, bug: cComment && mTasks > 0 && mProjects > 0, project: cProject && mProjects >= 2, doc: mDocs > 0,
    secret: cVault && role !== 'Guest', meeting: true, reminder: true, time: mTasks > 0 || mWork > 0,
  })[t];
  const kindAllowed = (k: ProjectKind) => (k === 'task' ? cTask && mTasks > 0 : k === 'issue' ? cComment && mTasks > 0 && mProjects > 0 : mProjects >= 2);

  const [text, setText] = useState(presetText);
  const [picked, setPicked] = useState<NewType | null>(presetType && allowed(presetType) ? presetType : null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [workTypeId, setWorkTypeId] = useState<string | null>(null);
  const [kind, setKind] = useState<ProjectKind | null>(inProject?.kind ?? null);
  const pathProject = /^\/work\/projects\/([0-9a-f-]{8,})/i.exec(loc.pathname)?.[1] ?? null;
  const [projectId, setProjectId] = useState<string | null>(inProject?.id ?? pathProject);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheetAnim = useAnimationControls();
  const [flying, setFlying] = useState(false);
  useEffect(() => { setTimeout(() => input.current?.focus(), 20); }, []);
  useEffect(() => { void sheetAnim.start({ opacity: 1, y: 0, scale: 1 }, still ? { duration: 0 } : spring.panel); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 5 * 60_000 });
  const people: QuickPerson[] = useMemo(() => (members.data ?? []).filter((m) => m.role !== 'Guest' && m.isActive !== false).map((m) => ({ id: m.userId, name: m.displayName })), [members.data]);
  const mePerson = me ? { id: me.id, name: me.displayName } : undefined;
  const parsed = useMemo(() => parseQuickTask(text.replace(/\b(?:give|hand|pass)\s+(?:it\s+)?to\b|\bowner:?(?=\s)/gi, 'assign to'), people, new Date(), mePerson), [text, people, mePerson?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const guessed = useMemo(() => guessType(text, allowed), [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const type = picked ?? guessed;
  const work = type === 'task' || type === 'ticket' || type === 'bug';
  const projectWork = type === 'task' || type === 'bug';

  const types = useWsQuery(['work', 'types'], () => workApi.types(), { enabled: type === 'ticket', staleTime: 5 * 60_000 });
  const sla = useWsQuery(['work', 'sla'], workApi.sla, { enabled: type === 'ticket', staleTime: 5 * 60_000, retry: false });
  const projects = useWsQuery(['projects', 'new-sheet'], () => projectApi.list({ pageSize: 200, sort: 'name' }), { enabled: work, staleTime: 60_000 });
  const activeTypes = (types.data ?? []).filter((t) => t.isActive);
  // Tickets: WhatsApp updates (only when the workspace's WhatsApp is connected and can send), who is on call, and similar open tickets.
  const ops = useWsQuery(['ops', 'settings'], opsApi.settings, { enabled: type === 'ticket', staleTime: 5 * 60_000, retry: false });
  const [triageText, setTriageText] = useState('');
  useEffect(() => { const t = window.setTimeout(() => setTriageText(type === 'ticket' ? text.trim() : ''), 600); return () => window.clearTimeout(t); }, [text, type]);
  const triage = useWsQuery(['ops', 'triage', triageText], () => opsApi.triage({ title: triageText }), { enabled: triageText.length >= 6, staleTime: 60_000, retry: false });
  // A ticket's type from its words ("bug", "access"…), else the first active type.
  const wordType = activeTypes.find((t) => text.toLowerCase().includes(t.name.toLowerCase().replace(/s$/, ''))) ?? activeTypes[0];
  const chosenType = activeTypes.find((t) => t.id === workTypeId) ?? wordType;
  const pr: Priority = priority ?? parsed.priority ?? 'Medium';
  const owner = ownerId === '' ? null : people.find((p) => p.id === (ownerId ?? parsed.assignee?.id)) ?? null;
  // A pasted paragraph is not a title: Aura writes a short one (or the first sentence, ≤ 120 characters, when AI is off) and the whole
  // text goes into the description, for every kind.
  const ai = useAi();
  const long = needsShortTitle(text);
  const [aiTitle, setAiTitle] = useState<{ for: string; title: string; ai: boolean } | null>(null);
  useEffect(() => {
    const words = text.trim();
    if (!ai || !long || aiTitle?.for === words) return;
    const t = window.setTimeout(() => {
      aiWorkspaceApi.title(words, picked ?? guessType(words, allowed) ?? undefined).then((r) => setAiTitle({ for: words, title: r.title, ai: r.ai })).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(t);
  }, [text, ai, long]); // eslint-disable-line react-hooks/exhaustive-deps
  const baseTitle = (parsed.title || text).trim();
  const shortTitle = aiTitle && aiTitle.for === text.trim() && aiTitle.title.trim() ? aiTitle.title.trim() : conciseTitle(baseTitle);
  const title = long ? (shortTitle.length > TITLE_MAX ? `${shortTitle.slice(0, TITLE_MAX - 1)}…` : shortTitle) : baseTitle;
  const description = long ? text.trim() : null;
  const def = TYPES.find((t) => t.id === type);
  const label = def?.label ?? '';

  // Project work belongs to a project: the one asked for, the page's, one named in the words, else the last one used.
  const live = (projects.data?.items ?? []).filter((p) => p.status !== 'Archived' && p.status !== 'Cancelled');
  const named = useMemo(() => { const t = ` ${text.toLowerCase()} `; return live.find((p) => t.includes(` ${p.key.toLowerCase()} `) || (p.name.length > 3 && t.includes(p.name.toLowerCase()))); }, [text, live]);
  const project = live.find((p) => p.id === projectId) ?? named ?? live.find((p) => p.id === readLast()) ?? null;
  const pkind: ProjectKind = type === 'bug' ? 'issue' : kind && kindAllowed(kind) ? kind : PROJECT_KINDS.find((k) => kindAllowed(k.id))?.id ?? 'task';
  const pkLabel = PROJECT_KINDS.find((k) => k.id === pkind)!.label;
  // The service level this ticket will get: its type's own targets, else the workspace's, for the priority.
  const levels = Array.isArray(sla.data?.defaults) ? sla.data! : null;
  const targets = levels ? (levels.overrides?.find((o) => o.workTypeId === chosenType?.id)?.targets ?? levels.defaults) : [];
  const slaOf = (p: Priority) => targets.find((t) => t.priority === p)?.resolutionMinutes ?? null;
  const shownLabel = type === 'task' ? pkLabel.toLowerCase() : label.toLowerCase();
  const color = def?.color ?? '#0071e3';

  /** Opens what was just made in the Work side panel: here, when this page shows one for its project; otherwise on Work. */
  const openMade = (id: string, inProject: string | null) => {
    if (inProject && pathProject === inProject && panelHosts.has(`project:${inProject}`)) {
      const n = new URLSearchParams(loc.search); n.set('item', id); nav(`${loc.pathname}?${n}`); return;
    }
    if (loc.pathname === '/work') { const n = new URLSearchParams(loc.search); n.set('item', id); nav(`/work?${n}`); return; }
    nav(`/work?item=${id}`);
  };

  /** The sheet shrinks and flies into the sidebar item the new thing lives in; that item's badge bumps. */
  const flyHome = async () => {
    const target = def ? document.querySelector<HTMLElement>(`.v2-rail-item[href$="${def.to === '/' ? '/' : def.to}"]`) : null;
    const box = sheetRef.current?.getBoundingClientRect();
    const to = target?.getBoundingClientRect();
    if (still || !box || !to || to.width === 0) return;
    setFlying(true);
    // Never let the flourish hold the sheet open: a busy or background tab can stall the animation, so cap the wait.
    await Promise.race([
      sheetAnim.start({ x: to.left + to.width / 2 - (box.left + box.width / 2), y: to.top + to.height / 2 - (box.top + box.height / 2), scale: 0.08, opacity: 0.35, borderRadius: 60 },
        { duration: 0.42, ease: [0.3, 0, 0.2, 1] }),
      new Promise((r) => window.setTimeout(r, 700)),
    ]);
    target!.classList.add('v2-landed');
    target!.querySelector('.v2-badge')?.classList.add('v2-bump');
    window.setTimeout(() => { target!.classList.remove('v2-landed'); target!.querySelector('.v2-badge')?.classList.remove('v2-bump'); }, 900);
  };

  const attach = async (id: string, k: WorkKind, projectOf: string | null) => {
    for (const f of files) {
      try {
        if (k === 'ticket') await workApi.upload(id, f);
        else if (projectOf && (k === 'task' || k === 'issue')) await uploadFile(attachmentApi.uploadPath(projectOf, k === 'task' ? id : undefined, k === 'issue' ? id : undefined), f);
      } catch { toast(`Could not attach ${f.name}.`, 'error'); }
    }
  };

  const makeWork = async () => {
    if (!title) { input.current?.focus(); return; }
    let k: WorkKind;
    const body: Parameters<typeof workItemsApi.create>[0] = { kind: 'task', title, description, priority: pr, assigneeId: owner?.id ?? null, dueDate: parsed.dueDate ?? null };
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
      if (files.length) await attach(made.id, k, made.projectId ?? null);
      refreshWork(wid);
      await flyHome();
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
      case 'task': case 'ticket': case 'bug': await makeWork(); return;
      case 'project': close(); onProject(); return;
      case 'reminder': close(); openReminderComposer(long ? { text: words, title, note: words } : { text: words }); return;
      case 'doc': close(); nav(join('/library?new=1', q('title', title), long ? q('body', words) : '')); return;
      case 'secret': close(); nav(join('/library/vault?new=item', q('title', title))); return;
      case 'meeting': close(); { const mp = (projectId ? live.find((p) => p.id === projectId) : null) ?? named ?? null; openScheduleFromWords(words, long ? { title, agenda: words } : undefined, mp ? { id: mp.id, name: mp.name } : null); } return;
      case 'time': close(); nav(join('/insights?tab=time', q('log', words))); return;
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void createIt(); }
    else if (e.key === 'Enter' && e.target === input.current) { e.preventDefault(); void createIt(); }
  };
  const goes = type === 'doc' ? 'Opens Library to write it.' : type === 'secret' ? 'Opens the Vault to fill in the secret.' : type === 'meeting' ? 'Opens the schedule sheet.'
    : type === 'time' ? 'Opens your timesheet with this entry.' : type === 'project' ? 'Opens the project form.' : type === 'reminder' ? 'Opens the reminder with the time it understood.'
    : projectWork && !project ? 'Pick the project it belongs to.' : projectWork && inProject && project?.id === inProject.id ? `Adds it to ${inProject.name}.` : null;
  // One line on why: the service level, who was named, the type and project it understood. Only what is known.
  const slaMin = type === 'ticket' ? slaOf(pr) : null;
  // Who is on call: the rota (routing rule) for this type, else the workspace's; round robin names the next person after the last one.
  const rule = type === 'ticket' ? (ops.data?.rules ?? []).filter((r) => r.enabled && r.members.length > 0)
    .sort((a, b) => Number(b.workTypeId === chosenType?.id) - Number(a.workTypeId === chosenType?.id))
    .find((r) => r.workTypeId === chosenType?.id || r.workTypeId === null) ?? null : null;
  const onCall = rule ? (rule.mode === 'round_robin'
    ? rule.members[(rule.members.findIndex((m) => m.id === rule.lastAssigned?.id) + 1) % rule.members.length] : null) : null;
  const first = (n: string) => n.split(' ')[0];
  const callLine = type !== 'ticket' || owner ? null : onCall ? `${first(onCall.name)} is on call`
    : rule ? `Goes to whoever on the ${rule.workType ?? 'desk'} rota has least open` : triage.data?.assignee ? `${first(triage.data.assignee.name)} solved similar${triage.data.assigneeReason ? ` (${triage.data.assigneeReason.split(' · ')[0]})` : ''}` : null;
  const dupes = type === 'ticket' ? triage.data?.duplicates?.length ?? 0 : 0;
  const why = [
    goes,
    type === 'ticket' && chosenType ? `${chosenType.name}` : null,
    slaMin ? `${pr} SLA is ${spell(slaMin)}` : null,
    callLine,
    dupes ? `${dupes} similar ticket${dupes === 1 ? '' : 's'} open` : null,
    owner && parsed.assignee?.id === owner.id && owner.id !== me?.id ? `${owner.name.split(' ')[0]} named in your words` : null,
    projectWork && project && !goes ? `In ${project.name}` : null,
  ].filter(Boolean).join(' · ') || 'Tap any chip to change it. Everything else can be added later.';
  const blocked = !type || busy || (!title && type !== 'reminder' && type !== 'time') || (projectWork && !project) || (type === 'ticket' && !chosenType && types.isSuccess);
  const due = parsed.dueDate ? `Due ${parsed.dueLabel ?? parsed.dueDate}` : slaMin ? `Due ${whenIn(slaMin)}` : null;

  // The chips, in the design's order: kind · priority · person · place · due. Each fades and rises in turn.
  const chips: React.ReactNode[] = [];
  const understood = !!type && (!!text.trim() || !!picked);
  if (understood) {
    chips.push(
      <Chip key="kind" label="Type" value={type === 'task' ? pkLabel : label} glyph={def?.glyph} color={color}>
        <select aria-label="Change type" value={type === 'ticket' ? `ticket:${chosenType?.id ?? ''}` : type === 'task' ? `task:${pkind}` : type}
          onChange={(e) => { const [t, sub] = e.target.value.split(':'); setPicked(t as NewType); if (t === 'ticket' && sub) setWorkTypeId(sub); if (t === 'task' && sub) setKind(sub as ProjectKind); }}>
          {TYPES.filter((t) => allowed(t.id)).flatMap((t) => t.id === 'ticket' && activeTypes.length
            ? activeTypes.map((w) => <option key={`ticket:${w.id}`} value={`ticket:${w.id}`}>Ticket · {w.name}</option>)
            : t.id === 'task' ? PROJECT_KINDS.filter((k) => k.id !== 'issue' && kindAllowed(k.id)).map((k) => <option key={`task:${k.id}`} value={`task:${k.id}`}>{k.label}</option>)
            : [<option key={t.id} value={t.id}>{t.label}</option>])}
          {type === 'ticket' && !activeTypes.length && <option value="ticket:">Ticket</option>}
        </select>
      </Chip>,
    );
    if (work) {
      chips.push(
        <Chip key="pr" label="Priority" value={pr} glyph="!" color={PRIORITY_COLOR[pr]} tone={pr === 'Critical' ? 'critical' : undefined}>
          <select aria-label="Change priority" value={pr} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}{slaOf(p) ? ` · ${spell(slaOf(p)!)}` : ''}</option>)}</select>
        </Chip>,
        <Chip key="who" label="Owner" value={owner?.name ?? 'Nobody yet'} avatar={owner ? initials(owner.name) : undefined}>
          <select aria-label="Change owner" value={owner?.id ?? ''} onChange={(e) => setOwnerId(e.target.value)}><option value="">Nobody yet</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me?.id ? ' (you)' : ''}</option>)}</select>
        </Chip>,
      );
      if (projectWork || (live.length > 0 && !!projectId)) chips.push(
        <Chip key="place" label="Project" value={projectWork ? project?.name ?? 'Choose…' : live.find((p) => p.id === projectId)?.name ?? 'None'} glyph="▤" color="#5856d6" warn={projectWork && !project}>
          <select aria-label="Change project" value={projectWork ? project?.id ?? '' : projectId ?? ''} onChange={(e) => setProjectId(e.target.value || null)}>
            <option value="" disabled={projectWork}>{projectWork ? 'Choose a project' : 'None'}</option>
            {live.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </select>
        </Chip>,
      );
      else chips.push(<Chip key="place" label="Goes to" value={def!.place} glyph={def!.glyph} color="linear-gradient(180deg,#ff6961,#ff3b30)" />);
      if (due) chips.push(<Chip key="due" label="Due" value={due} glyph="◷" color="#0071e3" />);
    } else if (def) chips.push(<Chip key="place" label="Opens in" value={def.place} glyph={def.glyph} color={def.color} />);
  }

  return (
    <motion.div className={`v2-new-scrim${flying ? ' flying' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
      animate={flying ? { backgroundColor: 'rgba(30,30,40,0.06)' } : undefined} transition={{ duration: 0.42 }}>
      <motion.div ref={sheetRef} className="v2-new-sheet" role="dialog" aria-modal="true" aria-labelledby="v2-new-title" onKeyDown={onKey}
        style={{ ['--kind' as string]: color }}
        initial={still ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98 }} animate={sheetAnim}>
        <div className="v2-new-head"><h2 id="v2-new-title">New</h2><span>Describe it — Aura fills in the rest · esc</span></div>
        <label className="v2-new-input">
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe it…" aria-label="What to create" />
        </label>
        <div className="v2-understood" aria-live="polite">
          <div className="v2-new-chips">
            <span className="v2-understood-label"><span className="v2-orb" aria-hidden="true" />Understood as{understood ? <span className="sr-only"> {/^[aeiou]/.test(shownLabel) ? 'an' : 'a'} {shownLabel}</span> : null}</span>
            {chips.map((c, i) => (
              <motion.span key={(c as React.ReactElement).key} className="v2-new-chip-wrap" initial={still ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: still ? 0 : 0.06 * i }}>{c}</motion.span>
            ))}
            {!understood && <span className="v2-new-shim" aria-hidden="true" />}
          </div>
          <p>{understood ? why : 'Type a sentence: what it is, how urgent, who and when.'}</p>
          {understood && long && type !== 'time' && (
            <p className="v2-new-titled" data-testid="new-short-title">
              <b>{aiTitle?.for === text.trim() && aiTitle.ai ? 'Aura titled it' : 'Title'}:</b> {title}<span> · the full text goes in the {type === 'meeting' ? 'agenda' : type === 'reminder' ? 'note' : 'description'}</span>
            </p>
          )}
        </div>
        <div className="v2-new-types" role="radiogroup" aria-label="Type">
          {TYPES.filter((t) => t.tile !== false).map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={type === t.id} className={`v2-new-type ${type === t.id ? 'on' : ''}`} disabled={!allowed(t.id)}
              style={{ ['--kind' as string]: t.color }} onClick={() => { setPicked(t.id); input.current?.focus(); }}>
              <span className="v2-new-type-tile" aria-hidden="true" data-glyph={t.glyph} />{t.label}
            </button>
          ))}
        </div>
        <div className="v2-new-foot">
          {work && (
            <>
              <input ref={fileInput} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
              <button type="button" className="v2-new-btn sm" onClick={() => fileInput.current?.click()} title={files.map((f) => f.name).join(', ') || undefined}>
                ＋ {files.length ? `${files.length} attached` : 'Attach'}
              </button>
            </>
          )}
          <span className="v2-new-sp" />
          <button type="button" className="v2-new-btn" onClick={close}>Cancel</button>
          <button type="button" className="v2-new-create" disabled={blocked} onClick={() => void createIt()}>
            {busy ? 'Creating…' : type ? `Create ${shownLabel}` : 'Create'}<kbd aria-hidden="true">⌘↵</kbd>
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** A chip that says what was understood; tapping it opens its choices (a native picker over the chip, so phones show their own). */
function Chip({ label, value, warn, glyph, color, avatar, tone, children }: { label: string; value: string; warn?: boolean; glyph?: string; color?: string; avatar?: string; tone?: 'critical'; children?: React.ReactNode }) {
  return (
    <span className={`v2-new-chip ${warn ? 'warn' : ''} ${children ? 'tap' : ''} ${tone ?? ''}`}>
      {avatar ? <span className="v2-new-chip-av" aria-hidden="true">{avatar}</span> : glyph ? <i aria-hidden="true" style={{ background: color }}>{glyph}</i> : null}
      <span className="sr-only">{label} </span><b>{value}</b>{children}
    </span>
  );
}
