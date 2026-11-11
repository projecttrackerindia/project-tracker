import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectApi, workspaceApi } from '../../api/endpoints';
import type { ProjectDetail, Stage, Task } from '../../api/types';
import { CalmAv, CalmOrb, CalmPicker, CalmSheet } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { AutomationPanel } from '../automation/AutomationPanel';
import { askExtensionReason, isExtension } from '../dates/ExtensionReason';
import type { DotsItem } from '../talk/DotsMenu';
import { WorkflowTab } from './ProjectTabs';
import {
  currentIndex, dm, errText, isClosed, lateDays, loadHint, moveStageDate, ordered, projectBody, SavedTick, StageOwnerSheet, useSaved,
} from './stagesKit';
import './stagesProject.css';

export type EditTab = 'stages' | 'details' | 'people' | 'statuses' | 'automation';
const TAB_LABEL: Record<EditTab, string> = { stages: 'Stages', details: 'Details', people: 'People', statuses: 'Statuses', automation: 'Automation' };

/**
 * Edit (the one button by the project's title): a right side panel on the web, a bottom sheet on a phone, with Stages · Details · People ·
 * Statuses · Automation. Everything saves as you go with ✓ Saved. Stages: rename in place, drag to reorder, owner chip (tap → who owns it),
 * date (later → why), + Add stage and "Move to <next> →". Close project and Delete (with undo) sit at the bottom.
 */
export function ProjectEditPanel({ open, detail, tasks, canEdit, initial = 'stages', onClose, more, onDelete, onShare, onHealth }: {
  open: boolean; detail: ProjectDetail; tasks: Task[] | undefined; canEdit: boolean; initial?: EditTab; onClose: () => void;
  /** The rarer project actions (Edit all fields, Save as template, Import…), listed under Details. */ more: DotsItem[];
  onDelete?: () => void; onShare: () => void; onHealth: () => void;
}) {
  const p = detail.project;
  const tabs: EditTab[] = canEdit ? ['stages', 'details', 'people', 'statuses', 'automation'] : ['stages', 'people'];
  const [tab, setTab] = useState<EditTab>(initial);
  useEffect(() => { if (open) setTab(tabs.includes(initial) ? initial : 'stages'); }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saved, flash] = useSaved();
  return (
    <CalmSheet open={open} onClose={onClose} width={620} clear className="stg-panel" label={`Edit ${p.name}`} title={p.name} actions={<SavedTick on={saved} />}>
      <div className="stg-tabs" role="tablist" aria-label="Edit">
        {tabs.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
      </div>
      <div className="stg-pane" data-tab={tab}>
        {tab === 'stages' && <StagesPane detail={detail} tasks={tasks} canEdit={canEdit} flash={flash} />}
        {tab === 'details' && <DetailsPane detail={detail} flash={flash} more={more} onHealth={onHealth} />}
        {tab === 'people' && <PeoplePane detail={detail} canEdit={canEdit} flash={flash} onShare={onShare} />}
        {tab === 'statuses' && <>
          <p className="stg-note">How a single task moves (To do → In progress → In review → Done). Kept separate from stages, which are the project’s journey.</p>
          <div className="stg-embed"><WorkflowTab projectId={p.id} statuses={detail.statuses} /></div>
        </>}
        {tab === 'automation' && <div className="stg-embed"><AutomationPanel projectId={p.id} statuses={detail.statuses} canEdit={canEdit && p.status !== 'Archived'} /></div>}
        {canEdit && (tab === 'stages' || tab === 'details') && <MorePane detail={detail} flash={flash} onDelete={onDelete} />}
      </div>
    </CalmSheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Stages

export function StagesPane({ detail, tasks, canEdit, flash }: { detail: ProjectDetail; tasks: Task[] | undefined; canEdit: boolean; flash: () => void }) {
  const p = detail.project;
  const wid = useWorkspaceId();
  const [local, setLocal] = useState<Stage[]>(() => ordered(detail.stages));
  useEffect(() => { setLocal(ordered(detail.stages)); }, [detail.stages]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [owning, setOwning] = useState<Stage | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const cur = currentIndex(local);
  const next = cur >= 0 ? local[cur + 1] ?? null : null;
  const done = (stages: Stage[]) => {
    setLocal(ordered(stages));
    queryClient.setQueryData<ProjectDetail>([wid, 'project', p.id], (d) => (d ? { ...d, stages } : d));
    void invalidateWorkspace(wid, 'project', p.id);
    flash();
  };

  const rename = async (s: Stage, name: string) => {
    setRenaming(null);
    const n = name.trim();
    if (!n || n === s.name) return;
    setLocal((l) => l.map((x) => (x.id === s.id ? { ...x, name: n } : x)));
    try { done(await projectApi.updateStage(p.id, s.id, { ...stageInput(s), name: n })); }
    catch (e) { setLocal(ordered(detail.stages)); toast(errText(e, 'Could not rename the stage.'), 'error'); }
  };
  const remove = async (s: Stage) => {
    if (!(await confirmDialog({ title: `Remove ${s.name}?`, message: 'Its tasks stay in the project, without a stage.', confirmText: 'Remove' }))) return;
    try { done(await projectApi.deleteStage(p.id, s.id)); } catch (e) { toast(errText(e, 'Could not remove the stage.'), 'error'); }
  };
  const date = async (s: Stage, to: string) => {
    const r = await moveStageDate(p.id, s, to || null);
    if (r) done(r);
  };
  const reorder = async (ids: string[]) => {
    const before = local;
    setLocal(ids.map((id) => local.find((s) => s.id === id)!));
    try { done(await projectApi.reorderStages(p.id, ids)); } catch (e) { setLocal(before); toast(errText(e, 'Could not reorder the stages.'), 'error'); }
  };
  const dropOn = (target: string) => {
    if (!drag || drag === target) return;
    const ids = local.map((s) => s.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(target) + (local.findIndex((s) => s.id === drag) < local.findIndex((s) => s.id === target) ? 1 : 0), 0, drag);
    setDrag(null);
    void reorder(ids);
  };
  const nudge = (s: Stage, d: -1 | 1) => {
    const ids = local.map((x) => x.id); const i = ids.indexOf(s.id); const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void reorder(ids);
  };
  const add = async () => {
    try {
      const r = await projectApi.createStage(p.id, { name: 'New stage', status: 'Pending' });
      done(r);
      const fresh = r.find((s) => !local.some((x) => x.id === s.id));
      if (fresh) setRenaming(fresh.id);
    } catch (e) { toast(errText(e, 'Could not add a stage.'), 'error'); }
  };
  const advance = async () => {
    if (moving) return;
    setMoving(true);
    try {
      let r;
      try { r = await projectApi.advanceStage(p.id, false); }
      catch (e) {
        if (!(e instanceof ApiError && e.code === 'STAGE_HAS_OPEN_TASKS' && next)) throw e;
        const open = tasks?.filter((t) => t.stageId === local[cur]?.id && t.statusCategory !== 'Done' && t.statusCategory !== 'Cancelled' && !t.parentTaskId).length;
        if (!(await confirmDialog({ title: `Move to ${next.name}?`, message: `${open ? `${open} task${open === 1 ? ' is' : 's are'}` : 'Some tasks are'} still open in ${local[cur].name}. They move to ${next.name} with the project.`, confirmText: `Move to ${next.name}`, danger: false }))) return;
        r = await projectApi.advanceStage(p.id, true);
      }
      done(r.stages);
      toast(next ? `Moved to ${next.name}. ${ownerName(next) ?? 'The next owner'} has been told.` : 'Every stage is complete.');
      void invalidateWorkspace(wid, 'project', p.id, 'tasks');
    } catch (e) { toast(errText(e, 'Could not move to the next stage.'), 'error'); }
    finally { setMoving(false); }
  };

  const curStage = cur >= 0 ? local[cur] : null;
  const curOwner = curStage?.owner ?? null;
  const curLoad = curOwner ? loadHint(curOwner.id, tasks) : null;
  const members = useMemo(() => detail.members.filter((m) => m.userId !== curOwner?.id).map((m) => ({ m, h: loadHint(m.userId, tasks) })).sort((a, b) => (a.h?.label === 'free' ? -1 : 0) - (b.h?.label === 'free' ? -1 : 0)), [detail.members, curOwner, tasks]);
  const freeOne = members.find((x) => x.h?.tone === 'free')?.m;
  const curOpen = curStage && curOwner ? (tasks ?? []).filter((t) => t.stageId === curStage.id && t.assignee?.id === curOwner.id && t.statusCategory !== 'Done' && t.statusCategory !== 'Cancelled').length : 0;

  return (
    <>
      <h5 className="stg-cap">Journey · Owner · Date</h5>
      <ol className="stg-stages" aria-label="Stages" data-testid="edit-stages">
        {local.map((s, i) => {
          const state = isClosed(s) ? 'done' : i === cur ? 'current' : 'next';
          const late = lateDays(s);
          const who = s.ownerTeamName ?? s.owner?.name ?? s.assignee?.name ?? null;
          const load = s.owner && state !== 'done' ? loadHint(s.owner.id, tasks) : null;
          return (
            <li key={s.id} className={`stg-stage ${state}${drag === s.id ? ' dragging' : ''}`} draggable={canEdit && renaming !== s.id}
              onDragStart={(e) => { setDrag(s.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDrag(null)}
              onDragOver={(e) => { if (drag) e.preventDefault(); }} onDrop={(e) => { e.preventDefault(); dropOn(s.id); }} data-stage={s.name}>
              <span className="stg-mark" aria-hidden="true">{state === 'done' ? <Icon name="tick" size={13} /> : i + 1}</span>
              {renaming === s.id ? (
                <span className="stg-rename">
                  <input autoFocus defaultValue={s.name} maxLength={80} aria-label="Stage name" onBlur={(e) => void rename(s, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                  <button type="button" className="stg-x" aria-label={`Remove ${s.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => void remove(s)}><Icon name="trash" size={14} /></button>
                </span>
              ) : <button type="button" className="stg-name" disabled={!canEdit} onClick={() => setRenaming(s.id)} title="Rename">{s.name}</button>}
              <button type="button" className="stg-chip" disabled={!canEdit} onClick={() => setOwning(s)} aria-label={`Owner of ${s.name}: ${who ?? 'nobody'}. Change`}>
                {who ? <CalmAv name={who} size={22} /> : <Icon name="userPlus" size={14} />}
                <span>{who ? (s.ownerTeamName ?? who.split(' ')[0]) : 'Owner'}</span>
                {load?.tone === 'over' && <em className="stg-over">Over</em>}
              </button>
              <label className={`stg-date${late ? ' late' : ''}`}>
                <span>{state === 'current' && s.plannedEnd && !late ? `→ ${dm(s.plannedEnd)}` : s.plannedEnd ? `${dm(s.plannedEnd)}${late ? ` · +${late}d` : ''}` : 'Date'}</span>
                <input type="date" value={s.plannedEnd ?? ''} disabled={!canEdit || state === 'done'} aria-label={`${s.name} date`}
                  onClick={(e) => { try { (e.target as HTMLInputElement).showPicker?.(); } catch { /* not supported */ } }}
                  onChange={(e) => void date(s, e.target.value)} />
              </label>
              {canEdit && <span className="stg-grip" aria-label={`Move ${s.name}`} role="button" tabIndex={0} title="Drag to reorder (or Alt+↑/↓)"
                onKeyDown={(e) => { if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); nudge(s, -1); } if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); nudge(s, 1); } }}>⋮⋮</span>}
            </li>
          );
        })}
      </ol>
      {canEdit && <button type="button" className="stg-add" onClick={() => void add()}><Icon name="plus" size={14} /> Add stage</button>}
      {curStage && curLoad?.tone === 'over' && curOwner && (
        <div className="stg-aura" role="note" data-testid="stage-aura">
          <CalmOrb />
          <p>{curOwner.name.split(' ')[0]} has {curLoad.label}. {freeOne ? <><b>Give {curStage.name} to {freeOne.name.split(' ')[0]}</b> (free here){curOpen ? ` and move ${curOpen} open task${curOpen === 1 ? '' : 's'}` : ''}?</> : `Hand ${curStage.name} to someone with room?`}</p>
          {canEdit && <button type="button" className="stg-go" onClick={() => setOwning(curStage)}>Reassign</button>}
        </div>
      )}
      {canEdit && <p className="stg-note">Tap a name to rename, a person to reassign, a date to move it (later dates ask why). Drag to reorder. <b>Move to next stage</b> notifies the next owner.</p>}
      {canEdit && curStage && (
        <button type="button" className="stg-move" onClick={() => void advance()} disabled={moving} data-testid="move-next">
          {next ? <>Move to {next.name} <Icon name="arrowRight" size={16} /></> : <>Complete {curStage.name} <Icon name="tick" size={16} /></>}
        </button>
      )}
      <StageOwnerSheet projectId={p.id} stage={owning} tasks={tasks} onClose={() => setOwning(null)} onSaved={(st) => done(st)} />
    </>
  );
}

const pickDate = (e: React.MouseEvent<HTMLInputElement>) => { try { e.currentTarget.showPicker?.(); } catch { /* unsupported */ } };
const ownerName = (s: Stage) => s.ownerTeamName ?? s.owner?.name ?? null;
const stageInput = (s: Stage) => ({
  name: s.name, status: s.status, plannedStart: s.plannedStart, plannedEnd: s.plannedEnd, actualStart: s.actualStart, actualEnd: s.actualEnd,
  ownerId: s.owner?.id ?? null, assigneeId: s.assignee?.id ?? null, description: s.description, durationDays: s.durationDays ?? null,
});

// ------------------------------------------------------------------------------------------------------------------ Details

function useProjectSave(detail: ProjectDetail, flash: () => void) {
  const wid = useWorkspaceId();
  const p = detail.project;
  return async (patch: Record<string, unknown>, what = 'the project') => {
    try {
      const d = await projectApi.update(p.id, projectBody(p, patch) as Parameters<typeof projectApi.update>[1]);
      queryClient.setQueryData([wid, 'project', p.id], d);
      void invalidateWorkspace(wid, 'projects');
      flash();
      return true;
    } catch (e) { toast(errText(e, `Could not save ${what}.`), 'error'); void invalidateWorkspace(wid, 'project', p.id); return false; }
  };
}

function DetailsPane({ detail, flash, more, onHealth }: { detail: ProjectDetail; flash: () => void; more: DotsItem[]; onHealth: () => void }) {
  const p = detail.project;
  const save = useProjectSave(detail, flash);
  const people = useWsQuery(['members', 'assignable'], workspaceApi.assignableMembers, { staleTime: 60_000 });
  const setDue = async (to: string) => {
    let dueDateReason: string | null = null;
    if (isExtension(p.dueDate, to || null, true)) { dueDateReason = await askExtensionReason({ what: 'due date', from: p.dueDate, to: to || null }); if (!dueDateReason) return; }
    await save({ dueDate: to || null, dueDateReason, extensionReason: dueDateReason }, 'the due date');
  };
  return (
    <div className="stg-rows" data-testid="edit-details">
      <label className="stg-row"><span>Name</span><input key={`n${p.version}`} defaultValue={p.name} maxLength={120} onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== p.name) void save({ name: v }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
      <div className="stg-row"><span>Owner</span>
        <CalmPicker label="Owner" value={p.owner?.id ?? null} recentKey="person" className="stg-pick"
          items={(people.data ?? []).map((m) => ({ id: m.userId, label: m.displayName, sub: m.jobRole }))} selected={p.owner ? { id: p.owner.id, label: p.owner.name } : null}
          onChange={(id) => id && id !== p.owner?.id && void save({ ownerId: id }, 'the owner')} />
      </div>
      <label className="stg-row"><span>Start</span>
        <span className="stg-val date"><b>{p.startDate ? dm(p.startDate) : 'Not set'}</b>
          <input type="date" value={p.startDate ?? ''} aria-label="Start date" onClick={pickDate} onChange={(e) => void save({ startDate: e.target.value || null }, 'the start date')} /></span>
      </label>
      <label className="stg-row"><span>Due</span>
        <span className="stg-val date"><b>{p.dueDate ? dm(p.dueDate) : 'Not set'}</b>
          <input type="date" value={p.dueDate ?? ''} aria-label="Due date" onClick={pickDate} onChange={(e) => void setDue(e.target.value)} /></span>
      </label>
      <button type="button" className="stg-row" onClick={onHealth}><span>Status</span><b>{p.health === 'OnTrack' ? 'On track' : p.health === 'AtRisk' ? 'At risk' : p.health} ›</b></button>
      <label className="stg-row col"><span>Description</span><textarea key={`d${p.version}`} rows={3} defaultValue={p.description ?? ''} maxLength={4000} placeholder="What this project delivers…"
        onBlur={(e) => { if (e.target.value !== (p.description ?? '')) void save({ description: e.target.value }); }} /></label>
      {more.filter((m) => !m.hidden).length > 0 && <h5 className="stg-cap">More</h5>}
      {more.filter((m) => !m.hidden).map((m) => (
        <button key={m.label} type="button" className="stg-row link" onClick={m.onSelect}><span>{m.label}{m.hint && <small>{m.hint}</small>}</span><Icon name="chevronR" size={14} /></button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------ People

function PeoplePane({ detail, canEdit, flash, onShare }: { detail: ProjectDetail; canEdit: boolean; flash: () => void; onShare: () => void }) {
  const wid = useWorkspaceId();
  const p = detail.project;
  const all = useWsQuery(['members'], workspaceApi.members, { enabled: canEdit });
  const available = (all.data ?? []).filter((m) => m.isActive !== false && !detail.members.some((x) => x.userId === m.userId));
  const add = async (id: string | null) => {
    if (!id) return;
    try { await projectApi.addMember(p.id, id); flash(); await invalidateWorkspace(wid, 'project', p.id); } catch (e) { toast(errText(e, 'Could not add them.'), 'error'); }
  };
  const remove = async (userId: string, name: string) => {
    if (!(await confirmDialog({ title: `Remove ${name}?`, message: 'They keep their workspace role and their tasks.', confirmText: 'Remove' }))) return;
    try { await projectApi.removeMember(p.id, userId); flash(); await invalidateWorkspace(wid, 'project', p.id); } catch (e) { toast(errText(e, 'Could not remove them.'), 'error'); }
  };
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="stg-rows" ref={ref} data-testid="edit-people">
      {detail.members.map((m) => (
        <div key={m.userId} className="stg-person">
          <CalmAv name={m.name} size={34} />
          <span className="stg-owner-t"><b>{m.name}</b><small>{m.userId === p.owner?.id ? 'Project owner' : m.role ?? 'Member'}{m.email ? ` · ${m.email}` : ''}</small></span>
          {canEdit && m.userId !== p.owner?.id && <button type="button" className="stg-x" aria-label={`Remove ${m.name}`} onClick={() => void remove(m.userId, m.name)}><Icon name="close" size={14} /></button>}
        </div>
      ))}
      {canEdit && available.length > 0 && (
        <div className="stg-row"><span>Add</span>
          <CalmPicker label="Add a person" value={null} placeholder="+ Add a person" recentKey="person" className="stg-pick"
            items={available.map((m) => ({ id: m.userId, label: m.displayName, sub: m.jobRole ?? m.role }))} onChange={(id) => void add(id)} />
        </div>
      )}
      <h5 className="stg-cap">Share</h5>
      <button type="button" className="stg-row link" onClick={onShare} data-testid="share-link"><span>Copy link<small>Anyone with access to the project can open it</small></span><Icon name="link" size={14} /></button>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------ More

function MorePane({ detail, flash, onDelete }: { detail: ProjectDetail; flash: () => void; onDelete?: () => void }) {
  const p = detail.project;
  const save = useProjectSave(detail, flash);
  const finished = p.status === 'Completed' || p.status === 'Cancelled' || p.status === 'Archived';
  const close = async () => {
    if (!finished && !(await confirmDialog({ title: `Close ${p.name}?`, message: 'It is marked completed. You can reopen it from here.', confirmText: 'Close project', danger: false }))) return;
    if (await save({ status: finished ? 'Active' : 'Completed' })) toast(finished ? 'Project reopened.' : 'Project closed.');
  };
  return (
    <div className="stg-more">
      <h5 className="stg-cap">More</h5>
      <button type="button" className="stg-row link" onClick={() => void close()}><span>{finished ? 'Reopen project' : 'Close project'}</span><Icon name="chevronR" size={14} /></button>
      {onDelete && <button type="button" className="stg-row link danger" onClick={onDelete} data-testid="delete-project"><span>Delete</span></button>}
    </div>
  );
}
