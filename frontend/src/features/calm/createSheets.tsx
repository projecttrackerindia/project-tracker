import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Select } from '../../components/Select';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { checklistApi, projectApi, projectGroupApi, teamApi, workspaceApi } from '../../api/endpoints';
import { workItemsApi } from '../../api/workItemsApi';
import type { Priority, Project } from '../../api/types';
import { CalmAv, CalmDot, CalmGo, CalmJourney, CalmLink, CalmPills, CalmSheet, CalmOrb, type CalmStep } from '../../components/calm';
import { DOW, MONTHS, todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { shiftIsoDate } from '../../lib/zone';
import { projectColor } from '../../lib/calm';
import { useAuth, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { parseQuick } from './quickParse';
import { openNew } from '../../components/v2/state';
import './calm-pages.css';
import { ActivityHistory } from '../dates/ActivityHistory';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
/** "Fri 6 Nov" */
export const shortDay = (iso: string | null | undefined) => { if (!iso) return ''; const d = new Date(`${iso}T00:00:00`); return `${DOW[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

// ------------------------------------------------------------------------------------------------------------- the + hook

export type CalmNewDetail = { type: 'task' | 'project'; project?: { id: string; name: string } | null; text?: string };
/**
 * Create project and Create task open from anywhere through one window event, so the shell's + button (and any page) can ask for them
 * without importing this module: `window.dispatchEvent(new CustomEvent('pt:new', { detail: { type: 'task' } }))`.
 */
export const openCalmNew = (detail: CalmNewDetail) => window.dispatchEvent(new CustomEvent<CalmNewDetail>('pt:new', { detail }));

/** The earlier pages are on (?classic=1, or pt_classic_pages): + keeps the earlier + New sheet. */
const classicOn = () => { try { return new URLSearchParams(location.search).get('classic') === '1' || localStorage.getItem('pt_classic_pages') === '1'; } catch { return false; } };

/** Listens for `pt:new` and shows the sheet. Mounted by the calm pages (Today, My work, Projects, a project). */
export function CalmCreateHost({ project }: { project?: { id: string; name: string } | null }) {
  const [open, setOpen] = useState<CalmNewDetail | null>(null);
  useEffect(() => {
    const on = (e: Event) => { if (classicOn()) return; const d = (e as CustomEvent<CalmNewDetail>).detail; if (d?.type === 'task' || d?.type === 'project') { e.preventDefault(); setOpen({ ...d, project: d.project ?? project ?? null }); } };
    window.addEventListener('pt:new', on);
    return () => window.removeEventListener('pt:new', on);
  }, [project]);
  return (
    <>
      <NewTaskSheet open={open?.type === 'task'} project={open?.project ?? null} text={open?.text} onClose={() => setOpen(null)} />
      <ProjectSheet open={open?.type === 'project'} onClose={() => setOpen(null)} />
    </>
  );
}

// ------------------------------------------------------------------------------------------------------------- New task (10b)

const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Critical'];
const PRIORITY_LABEL: Record<Priority, string> = { Low: 'Low', Medium: 'Medium', High: 'High', Critical: 'Urgent' };

export function NewTaskSheet({ open, onClose, project, text }: { open: boolean; onClose: () => void; project?: { id: string; name: string } | null; text?: string }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx?.user);
  const today = todayISO();
  const members = useWsQuery(['members'], () => workspaceApi.members(), { enabled: open, staleTime: 5 * 60_000 });
  const projects = useWsQuery(['projects', 'calm-pick'], () => projectApi.list({ pageSize: 100 }), { enabled: open, staleTime: 60_000 });
  const [quick, setQuick] = useState('');
  const [projectId, setProjectId] = useState<string>('');
  const [stageId, setStageId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [estimate, setEstimate] = useState('');
  const [start, setStart] = useState(today);
  const [due, setDue] = useState('');
  const [priority, setPriority] = useState<Priority>('Medium');
  const [checks, setChecks] = useState<string[]>([]);
  const [newCheck, setNewCheck] = useState('');
  const [busy, setBusy] = useState(false);
  const touched = useRef<{ owner?: boolean; due?: boolean; project?: boolean; priority?: boolean }>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuick(text ?? ''); setProjectId(project?.id ?? ''); setStageId(''); setOwnerId(me?.id ?? ''); setEstimate(''); setStart(today); setDue(''); setPriority('Medium'); setChecks([]); setNewCheck('');
    touched.current = {};
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = useMemo(() => projects.data?.items ?? [], [projects.data]);
  const people = useMemo(() => (members.data ?? []).filter((m) => m.isActive !== false && m.role !== 'Guest'), [members.data]);
  const parsed = useMemo(() => parseQuick(quick, today, people.map((m) => ({ id: m.userId, name: m.displayName })), list.map((p) => ({ id: p.id, key: p.key, name: p.name }))), [quick, today, people, list]);
  // What the words say fills the fields, unless the person set that field by hand.
  useEffect(() => {
    if (parsed.ownerId && !touched.current.owner) setOwnerId(parsed.ownerId);
    if (parsed.due && !touched.current.due) setDue(parsed.due);
    if (parsed.projectId && !touched.current.project) setProjectId(parsed.projectId);
    if (parsed.priority && !touched.current.priority) setPriority(parsed.priority);
  }, [parsed.ownerId, parsed.due, parsed.projectId, parsed.priority]);
  const detail = useWsQuery(['project', projectId], () => projectApi.get(projectId), { enabled: open && !!projectId, staleTime: 60_000 });
  const stages = [...(detail.data?.stages ?? [])].sort((a, b) => a.order - b.order);
  const chosen = list.find((p) => p.id === projectId) ?? (project && project.id === projectId ? { id: project.id, name: project.name, key: '' } as Pick<Project, 'id' | 'name' | 'key'> : null);
  const owner = people.find((m) => m.userId === ownerId);

  const create = async () => {
    const title = parsed.title.trim();
    if (!title) { toast('Give the task a title.', 'info'); inputRef.current?.focus(); return; }
    if (!projectId) { toast('Choose a project for the task.', 'info'); return; }
    setBusy(true);
    try {
      const hours = estimate ? parseEstimate(estimate) : null;
      const item = await workItemsApi.create({ kind: 'task', title, projectId, assigneeId: ownerId || null, priority, startDate: start || null, dueDate: due || null, stageId: stageId || null, estimatedHours: hours });
      for (const c of checks) { try { await checklistApi.add(item.id, c); } catch { /* the task exists; a checklist line can be added later */ } }
      toast(`${item.key ?? 'Task'} created.`);
      refreshWork(wid); void invalidateWorkspace(wid, 'project'); void invalidateWorkspace(wid, 'projects');
      onClose();
      if (!project) nav(`/work?item=${item.id}`);
    } catch (e) { toast(errText(e, 'Could not create the task.'), 'error'); }
    finally { setBusy(false); }
  };
  const keys = (e: React.KeyboardEvent) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void create(); } };

  return (
    <CalmSheet open={open} onClose={onClose} title="New task" width={835}>
      <div className="cm-form" onKeyDown={keys}>
        <label className="cm-quick">
          <CalmOrb />
          <input ref={inputRef} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Fix refund retries @owner fri #project" aria-label="Task, with @owner, a day and #project"
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void create(); } }} />
          <kbd>↵ to add</kbd>
        </label>
        <div className="cm-parsed" aria-live="polite">
          {parsed.title && <span className="cm-chip"><small>Title</small>{parsed.title}</span>}
          {owner && <span className="cm-chip"><CalmAv name={owner.displayName} size={20} />{owner.displayName}</span>}
          {due && <span className="cm-chip"><small>Due</small>{shortDay(due)}</span>}
          {chosen && <span className="cm-chip"><CalmDot color={projectColor(chosen.id)} />{chosen.name}</span>}
          <span className="cm-hint">Parsed as you type</span>
        </div>
        <div className="cm-sec">Or add details</div>
        <div className="cm-grid2">
          <div className="cm-col">
            <div className="cm-pair">
              <Field label="Project"><Select className="cm-in" value={projectId} onChange={(e) => { touched.current.project = true; setProjectId(e.target.value); setStageId(''); }}>
                <option value="">Choose…</option>{list.filter((p) => p.status !== 'Archived').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                {project && !list.some((p) => p.id === project.id) && <option value={project.id}>{project.name}</option>}
              </Select></Field>
              <Field label="Phase"><Select className="cm-in" value={stageId} onChange={(e) => setStageId(e.target.value)} disabled={!stages.length}>
                <option value="">{stages.length ? 'Any phase' : 'No phases'}</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select></Field>
            </div>
            <div className="cm-pair">
              <Field label="Owner"><Select className="cm-in" value={ownerId} onChange={(e) => { touched.current.owner = true; setOwnerId(e.target.value); }}>
                <option value="">Nobody yet</option>{people.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
              </Select></Field>
              <Field label="Estimate"><input className="cm-in" value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="50 min" /></Field>
            </div>
            <div className="cm-pair">
              <Field label="Start"><input className="cm-in" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Due"><input className="cm-in" type="date" value={due} min={start || undefined} onChange={(e) => { touched.current.due = true; setDue(e.target.value); }} /></Field>
            </div>
            <Field label="Priority"><CalmPills label="Priority" value={priority} onChange={(v) => { touched.current.priority = true; setPriority(v); }} options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))} /></Field>
          </div>
          <div className="cm-col">
            <div className="cm-lab">Checklist</div>
            <ul className="cm-checks">
              {checks.map((c, i) => <li key={`${c}${i}`}><span className="cm-ring" aria-hidden="true" /><span>{c}</span><button type="button" className="cm-x" aria-label={`Remove ${c}`} onClick={() => setChecks((x) => x.filter((_, j) => j !== i))}>×</button></li>)}
            </ul>
            <form className="cm-add" onSubmit={(e) => { e.preventDefault(); const t = newCheck.trim(); if (t) { setChecks((x) => [...x, t]); setNewCheck(''); } }}>
              <input className="cm-add-in" value={newCheck} onChange={(e) => setNewCheck(e.target.value)} placeholder="+ Add item" aria-label="Add a checklist item" />
            </form>
            <div className="cm-lab">Dependencies</div>
            <p className="cm-note">Link what blocks it from the task once it exists.</p>
          </div>
        </div>
      </div>
      <div className="cm-foot">
        <CalmGo onClick={() => void create()} disabled={busy}>{busy ? 'Creating…' : 'Create task'}</CalmGo>
        <CalmLink onClick={onClose}>Cancel</CalmLink>
        <CalmLink onClick={() => { onClose(); openNew(null, quick); }}>Ticket, bug or other ›</CalmLink>
        <span className="cm-foot-r">⌘↵ create · Esc close</span>
      </div>
    </CalmSheet>
  );
}

/** "50 min", "1h 30m", "2h", "1.5" → hours. */
export function parseEstimate(s: string): number | null {
  const t = s.toLowerCase().trim();
  const h = /(\d+(?:\.\d+)?)\s*h/.exec(t), m = /(\d+)\s*m/.exec(t);
  if (h || m) return Math.round(((h ? Number(h[1]) : 0) + (m ? Number(m[1]) / 60 : 0)) * 100) / 100;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="cm-field"><span className="cm-lab">{label}</span>{children}</label>;
}

// ------------------------------------------------------------------------------------------------------------- New / Edit project (08d, 09b)

export function ProjectSheet({ open, onClose, project }: { open: boolean; onClose: () => void; project?: Project | null }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx?.user.id ?? '');
  const canTeams = useModule('teams') > 0;
  const edit = !!project;
  const members = useWsQuery(['members'], () => workspaceApi.members(), { enabled: open, staleTime: 5 * 60_000 });
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: open && canTeams, staleTime: 5 * 60_000, retry: false });
  const groups = useWsQuery(['project-groups'], () => projectGroupApi.list(), { enabled: open && !edit, staleTime: 5 * 60_000 });
  const templates = useWsQuery(['timeline-templates'], projectApi.timelineTemplates, { enabled: open && !edit, staleTime: 5 * 60_000 });
  const [name, setName] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [start, setStart] = useState('');
  const [target, setTarget] = useState('');
  const [desc, setDesc] = useState('');
  const [tpl, setTpl] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? ''); setOwnerId(project?.owner?.id ?? me); setTeamId(project?.teamId ?? ''); setStart(project?.startDate ?? todayISO());
    setTarget(project?.dueDate ?? shiftIsoDate(todayISO(), 30)); setDesc(project?.description ?? ''); setTpl('');
  }, [open, project, me]);
  const tlist = useMemo(() => templates.data ?? [], [templates.data]);
  useEffect(() => { if (open && !edit && !tpl && tlist.length) setTpl((tlist.find((t) => t.isDefault) ?? tlist[0]).key); }, [open, edit, tpl, tlist]);
  const chosen = tlist.find((t) => t.key === tpl);
  const team = (teams.data ?? []).find((t) => t.id === teamId);

  const save = async () => {
    if (!name.trim()) { toast('Give the project a name.', 'info'); return; }
    if (start && target && target < start) { toast('The target must not be before the start.', 'info'); return; }
    setBusy(true);
    try {
      const base = { name: name.trim(), description: desc.trim() || undefined, ownerId: ownerId || null, teamId: teamId || null, startDate: start || null, dueDate: target || null };
      if (edit && project) {
        await projectApi.update(project.id, { ...base, priority: project.priority, status: project.status, version: project.version, enforceDependencies: project.enforceDependencies,
          projectGroupId: project.projectGroupId, projectType: project.projectType, deliveryMethod: project.deliveryMethod, dueDateReason: null });   // a later target asks for the reason in the shared sheet
        toast('Saved.'); await invalidateWorkspace(wid); onClose();
      } else {
        const pickable = (groups.data ?? []).filter((g) => g.isActive);
        const group = pickable.find((g) => /^other/i.test(g.name)) ?? pickable[0];
        if (!group) { toast('Add a project group in Settings first.', 'error'); return; }
        const res = await projectApi.create({ ...base, priority: 'Medium', status: 'Planning', projectGroupId: group.id, projectType: 'Other', deliveryMethod: 'Hybrid', timelineTemplate: tpl || undefined, memberIds: [] });
        toast('Project created.'); await invalidateWorkspace(wid); onClose(); nav(`/work/projects/${res.project.id}`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') { toast('Someone else changed this project. Reloaded the latest version.', 'warning'); await invalidateWorkspace(wid); onClose(); return; }
      toast(errText(e, 'Could not save the project.'), 'error');
    } finally { setBusy(false); }
  };
  const steps: CalmStep[] = (chosen?.stages ?? []).map((s, i) => ({ key: `${s}${i}`, label: s, state: 'next' }));
  const people = (members.data ?? []).filter((m) => m.isActive !== false && m.role !== 'Guest');
  return (
    <CalmSheet open={open} onClose={onClose} title={edit ? 'Edit project' : 'New project'} width={835}>
      <div className="cm-form" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); } }}>
        <div className="cm-grid2">
          <div className="cm-col">
            <Field label="Name"><input className="cm-in" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Project name" autoFocus /></Field>
            <div className="cm-pair">
              <Field label="Owner"><Select className="cm-in" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>{people.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
              <Field label="Team"><Select className="cm-in" value={teamId} onChange={(e) => setTeamId(e.target.value)}><option value="">No team</option>{(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
            </div>
            <div className="cm-pair">
              <Field label="Start"><input className="cm-in" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Target"><input className="cm-in" type="date" value={target} min={start || undefined} onChange={(e) => setTarget(e.target.value)} /></Field>
            </div>
            <Field label="Description"><textarea className="cm-in cm-ta" value={desc} onChange={(e) => setDesc(e.target.value)} rows={4} placeholder="What it is for, and its first milestone." /></Field>
          </div>
          <div className="cm-col">
            {edit ? (
              <>
                <div className="cm-lab">Colour</div>
                <p className="cm-note"><CalmDot color={projectColor(project!.id)} /> Every project keeps one dot colour, the same on every screen.</p>
                <p className="cm-note">Phases, members, workflow and automation are in the project’s ⋯ menu.</p>
                <div className="cm-lab">Activity</div>
                <div className="cm-activity"><ActivityHistory type="project" id={project!.id} /></div>
              </>
            ) : (
              <>
                <div className="cm-lab">Template</div>
                <div className="cm-tpls" role="radiogroup" aria-label="Template">
                  {tlist.map((t) => (
                    <button key={t.key} type="button" role="radio" aria-checked={tpl === t.key} className={`cm-tpl${tpl === t.key ? ' on' : ''}`} onClick={() => setTpl(t.key)}>
                      <span className="cm-radio" aria-hidden="true" />
                      <span><b>{t.name}</b><small>{t.stages.join(' → ')}</small></span>
                    </button>
                  ))}
                  {templates.isLoading && <p className="cm-note">Loading templates…</p>}
                </div>
                {steps.length > 0 && <><div className="cm-lab">Journey preview</div><CalmJourney steps={steps} label="Journey preview" /></>}
                {chosen && <div className="cm-aura"><CalmOrb /><span>The project starts with the {chosen.stages.length} phases of {chosen.name}. You can rename or reorder them after.</span></div>}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="cm-foot">
        <CalmGo onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : edit ? 'Save' : 'Create project'}</CalmGo>
        <CalmLink onClick={onClose}>Cancel</CalmLink>
        <span className="cm-foot-r">{team ? `Visible to the ${team.name} team` : 'Visible to its members'}</span>
      </div>
    </CalmSheet>
  );
}

/** A project's dot style (for inline use). */
export const dotStyle = (id: string) => ({ '--calm-dot': projectColor(id) } as CSSProperties);
