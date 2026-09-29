import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi, projectGroupApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { Priority, Project, ProjectStatus, ProjectType } from '../../api/types';
import { Field, Modal, SubmitButton, PriorityOptions } from '../../components/ui';
import { PROJECT_STATUSES, dateOffset, labelize, todayISO } from '../../lib/format';
import { PROJECT_TYPES } from '../../lib/workLabels';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { StageChain, TimelineManagerModal, useTimelineManagement, useTimelineTemplates } from './TimelineTemplates';
import { Select } from '../../components/Select';
import { Link } from 'react-router-dom';
import { DueChangeFields, dueChange } from './DueChangeFields';

export function ProjectFormModal({ project, onClose, onSaved }: { project?: Project; onClose: () => void; onSaved?: (id: string) => void }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx!.user.id);
  const personal = useIsPersonal();
  const isEdit = !!project;
  const members = useWsQuery(['members'], workspaceApi.members);
  const canSeeTeams = useModule('teams') > 0;
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: !personal && canSeeTeams });

  const [name, setName] = useState(project?.name ?? '');
  const [key, setKey] = useState(project?.key ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [ownerId, setOwnerId] = useState(project?.owner?.id ?? me);
  const [teamId, setTeamId] = useState(project?.teamId ?? '');
  const [groupId, setGroupId] = useState(project?.projectGroupId ?? '');
  const [projectType, setProjectType] = useState<ProjectType | ''>(project?.projectType ?? '');
  const [dueReason, setDueReason] = useState('');
  const [dueDependency, setDueDependency] = useState('');
  const groups = useWsQuery(['project-groups'], () => projectGroupApi.list());
  const canManageGroups = useCan('projectgroups.manage');
  // Only active groups can be picked; a project keeps showing the (inactive) group it is already in.
  const pickable = (groups.data ?? []).filter((g) => g.isActive || g.id === project?.projectGroupId);
  const [priority, setPriority] = useState<Priority>(project?.priority ?? 'Medium');
  const [status, setStatus] = useState<ProjectStatus>(project?.status ?? 'Planning');
  const [startDate, setStartDate] = useState(project?.startDate ?? todayISO());
  const [dueDate, setDueDate] = useState(project?.dueDate ?? dateOffset(30));
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [enforce, setEnforce] = useState(project?.enforceDependencies ?? true);
  const [timeline, setTimeline] = useState('');
  const templates = useTimelineTemplates(!isEdit);
  const chosen = templates.data?.find((t) => t.key === timeline);
  const [managing, setManaging] = useState(false);
  const { permitted: canManageTimelines } = useTimelineManagement();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const base = { name: name.trim(), description: description.trim() || undefined, priority, ownerId: ownerId || null, teamId: teamId || null, startDate: startDate || null, dueDate: dueDate || null, projectGroupId: groupId, projectType };
      const moved = isEdit && dueChange(project!.dueDate, dueDate);
      return isEdit
        ? projectApi.update(project!.id, { ...base, status, version: project!.version, enforceDependencies: enforce, dueDateReason: moved ? dueReason.trim() || null : null, dueDateDependency: moved ? dueDependency.trim() || null : null })
        : projectApi.create({ ...base, key: key.trim() || undefined, status, memberIds, timelineTemplate: timeline });
    },
    onSuccess: async (res) => { toast(isEdit ? 'Project updated.' : 'Project created.'); await invalidateWorkspace(wid); onSaved?.(res.project.id); onClose(); },
    onError: async (err) => {
      if (!(err instanceof ApiError)) { setFormError('Could not save the project.'); return; }
      if (err.code === 'VERSION_CONFLICT') { toast('Someone else changed this project. Reloaded the latest version.', 'warning'); await invalidateWorkspace(wid); onClose(); return; }
      const fe: Record<string, string> = {};
      err.errors.forEach((x) => { if (x.field) fe[x.field] = x.message; });
      setErrors(fe);
      if (!Object.keys(fe).length) setFormError(err.message);
    },
  });

  const submit = () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Project name is required.';
    if (!groupId) e.projectGroupId = 'Choose a project group.';
    if (!projectType) e.projectType = 'Choose a project type.';
    if (!isEdit && !timeline) e.timelineTemplate = 'Select the project timeline.';
    if (isEdit && dueChange(project!.dueDate, dueDate)?.delay && !dueReason.trim()) e.dueDateReason = 'Say why the due date is moving.';
    if (!startDate) e.startDate = 'Start date is required.';
    if (!dueDate) e.dueDate = 'Due date is required.';
    if (startDate && dueDate && dueDate < startDate) e.dueDate = 'Due date must not be before the start date.';
    setErrors(e); setFormError(null);
    if (!Object.keys(e).length) save.mutate();
  };

  const statusOptions = isEdit ? PROJECT_STATUSES : (['Planning', 'Active', 'OnHold'] as const);

  return (
    <Modal size="lg" title={isEdit ? 'Edit project' : 'New project'} subtitle={isEdit ? 'Update project details and timeline.' : 'Set up a project to organise your tasks.'}
      onClose={onClose} onSubmit={(e) => { e.preventDefault(); submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>{isEdit ? 'Save changes' : 'Create project'}</SubmitButton></>}>
      {formError && <div className="form-error" role="alert">{formError}</div>}
      <div className="form-grid">
        <Field label="Project name" required error={errors.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. API Migration" /></Field>
        <Field label="Project key" error={errors.key} hint={isEdit ? 'Keys cannot be changed after creation.' : 'Optional — used in task IDs, e.g. API-12.'}>
          <input className="input" value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} maxLength={10} placeholder="e.g. API" disabled={isEdit} />
        </Field>
        <Field label="Description" full><textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" maxLength={4000} /></Field>
        <Field label="Project group" required error={errors.projectGroupId}
          hint={pickable.length === 0 && groups.isSuccess ? 'There is no active project group yet.' : 'Every project belongs to one group; the Project Status page is organized by them.'}>
          <Select className="select" value={groupId} onChange={(e) => { setGroupId(e.target.value); setErrors((x) => ({ ...x, projectGroupId: '' })); }} aria-label="Project group">
            <option value="">Select a project group…</option>
            {pickable.map((g) => <option key={g.id} value={g.id}>{g.name}{g.isActive ? '' : ' (inactive)'}</option>)}
          </Select>
          {canManageGroups && <Link className="link" style={{ marginTop: 6, display: 'inline-block' }} to="/project-groups" onClick={onClose}>Manage project groups…</Link>}
        </Field>
        <Field label="Project type" required error={errors.projectType} hint={PROJECT_TYPES.find((t) => t.id === projectType)?.hint ?? 'What the project is for: a new system, a change request, an enhancement, a migration ...'}>
          <Select className="select" value={projectType} onChange={(e) => { setProjectType(e.target.value as ProjectType); setErrors((x) => ({ ...x, projectType: '' })); }} aria-label="Project type">
            <option value="">Select a project type…</option>
            {PROJECT_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
        </Field>
        <Field label="Project owner" error={errors.ownerId}>
          <Select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {members.data?.filter((m) => m.role !== 'Guest').map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </Select>
        </Field>
        {!personal && (
          <Field label="Team">
            <Select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">No team</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Start date" required error={errors.startDate}><input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
        <Field label="Due date" required error={errors.dueDate}><input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
        {isEdit && (
          <div className="field full" style={{ display: dueChange(project!.dueDate, dueDate) ? undefined : 'none' }}>
            <DueChangeFields previous={project!.dueDate} revised={dueDate} reason={dueReason} dependency={dueDependency} onReason={(v) => { setDueReason(v); setErrors((x) => ({ ...x, dueDateReason: '' })); }} onDependency={setDueDependency} error={errors.dueDateReason} />
          </div>
        )}
        <Field label="Priority"><Select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}><PriorityOptions /></Select></Field>
        <Field label="Status"><Select className="select" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>{statusOptions.map((s) => <option key={s} value={s}>{labelize(s)}</option>)}</Select></Field>
        {!isEdit && (
          <Field label="Project timeline" required full error={errors.timelineTemplate}
            hint="The stages are worked through in order: each one unlocks once the stage before it is completed.">
            <Select className="select" value={timeline} onChange={(e) => { setTimeline(e.target.value); setErrors((x) => ({ ...x, timelineTemplate: '' })); }} aria-label="Project timeline">
              <option value="">Select a timeline…</option>
              <optgroup label="Built in">{templates.data?.filter((t) => !t.isCustom).map((t) => <option key={t.key} value={t.key}>{t.name}{t.isDefault ? ' (default)' : ''}</option>)}</optgroup>
              {templates.data?.some((t) => t.isCustom) && <optgroup label="Your timelines">{templates.data.filter((t) => t.isCustom).map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</optgroup>}
            </Select>
            {canManageTimelines && <button type="button" className="link" style={{ marginTop: 6, textAlign: 'left' }} onClick={() => setManaging(true)}>Manage timelines…</button>}
            {chosen && (
              <>
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{chosen.description}</div>
                <StageChain stages={chosen.stages} />
              </>
            )}
          </Field>
        )}
        {project && (
          <Field label="Task dependencies" full hint="When on, a task cannot start or finish before the tasks it depends on.">
            <label className="row" style={{ gap: 8, fontSize: 13 }}><input type="checkbox" checked={enforce} onChange={(e) => setEnforce(e.target.checked)} /> Enforce dependencies in this project</label>
          </Field>
        )}
        {!isEdit && !personal && members.data && members.data.length > 1 && (
          <Field label="Team members" full hint="Guests only see projects they are added to. Add or remove people later from the project's Team tab.">
            <div className="member-list" style={{ maxHeight: 160, overflowY: 'auto', gap: 6 }}>
              {members.data.filter((m) => m.userId !== ownerId).map((m) => (
                <label key={m.userId} className="member-item" style={{ padding: '6px 10px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={memberIds.includes(m.userId)} onChange={(e) => setMemberIds((c) => e.target.checked ? [...c, m.userId] : c.filter((x) => x !== m.userId))} />
                  <span className="member-main"><span className="member-name">{m.displayName}</span> <span className="muted" style={{ fontSize: 11 }}>{m.role}</span></span>
                </label>
              ))}
            </div>
          </Field>
        )}
      </div>
      {managing && <TimelineManagerModal onClose={() => { setManaging(false); if (timeline && !templates.data?.some((t) => t.key === timeline)) setTimeline(''); }} />}
    </Modal>
  );
}
