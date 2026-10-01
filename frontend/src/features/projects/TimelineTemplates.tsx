import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import type { TimelineTemplate } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, Field, Modal, PageHead, PageLoader, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

/** The timelines a new project can start from: the built-in ones and the workspace's own. */
export function useTimelineTemplates(enabled = true) {
  return useWsQuery(['timeline-templates'], projectApi.timelineTemplates, { enabled });
}

/** Creating, editing and deleting a workspace's own timelines needs "manage workflows" and a plan with custom workflows. */
export function useTimelineManagement() {
  const permitted = useCan('workflow.manage');
  const entitled = useEntitlement('CUSTOM_WORKFLOWS') !== 0;
  return { permitted, entitled, allowed: permitted && entitled };
}

/** Stages as a chain of chips: Project Created → Planning → … */
export function StageChain({ stages }: { stages: string[] }) {
  return (
    <div className="tl-preview" aria-label="Stages of this timeline">
      {stages.map((s, i) => <Fragment key={`${s}-${i}`}>{i > 0 && <span className="tl-arrow" aria-hidden="true">→</span>}<span className="tl-step">{s}</span></Fragment>)}
    </div>
  );
}

// ------------------------------------------------------------------ the list

/**
 * All the timelines, with a way to make your own: from scratch, or by saving the stages of the project being looked at.
 * Built-in ones are shown for reference and cannot be changed.
 */
export function TimelineManagerModal({ onClose, project }: { onClose: () => void; project?: { id: string; name: string } }) {
  return (
    <Modal size="lg" title="Project timelines" subtitle="Ready-made lifecycles a new project can start from. A project copies its timeline, so changing one here never changes an existing project." onClose={onClose}
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <TimelineTemplateList project={project} onLeave={onClose} />
    </Modal>
  );
}

/** Workspace settings → Timeline templates: the same list, as a page of its own (they are workspace-wide, not part of any one project). */
export function TimelineTemplatesSettings() {
  return (
    <>
      <PageHead title="Timeline templates" sub="Ready-made lifecycles a new project can start from. A project copies its timeline, so changing one here never changes an existing project." />
      <div className="card"><div className="card-body"><TimelineTemplateList /></div></div>
    </>
  );
}

function TimelineTemplateList({ project, onLeave }: { project?: { id: string; name: string }; onLeave?: () => void }) {
  const wid = useWorkspaceId();
  const { allowed, entitled } = useTimelineManagement();
  const q = useTimelineTemplates();
  const [editing, setEditing] = useState<TimelineTemplate | 'new' | null>(null);
  const [saving, setSaving] = useState(false);

  const remove = async (t: TimelineTemplate) => {
    if (!t.id || !(await confirmDialog({ title: 'Delete timeline?', message: `Delete “${t.name}”? Projects that already use it keep their stages.` }))) return;
    try { await projectApi.deleteTimelineTemplate(t.id); toast('Timeline deleted.', 'warning'); await invalidateWorkspace(wid, 'timeline-templates'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the timeline.', 'error'); }
  };

  return (
    <>
        {!allowed && (
          <div className="form-warn" style={{ marginTop: 0 }}>
            <Icon name="lock" size={14} /> {entitled ? 'You need the “manage workflows” permission to make your own timelines.' : <>Your own timelines are part of plans with custom workflows. <Link className="link" to="/settings/billing" onClick={onLeave}>View plans</Link></>}
          </div>
        )}
        {allowed && (
          <div className="row" style={{ gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Icon name="plus" /> New timeline</button>
            {project && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSaving(true)}><Icon name="layers" /> Save “{project.name}” stages as a timeline</button>}
          </div>
        )}
        {q.isLoading ? <PageLoader /> : !q.data?.length ? <EmptyState icon="flag" title="No timelines" text="Something went wrong loading the timelines." /> : (
          <div className="tpl-list">
            {q.data.map((t) => (
              <div className="tpl-item" key={t.key}>
                <div className="tpl-head">
                  <div className="row" style={{ gap: 8 }}>
                    <span className="tpl-name">{t.name}</span>
                    <span className={`badge ${t.isCustom ? 'badge-purple' : 'badge-neutral'}`}>{t.isCustom ? 'Yours' : 'Built in'}</span>
                    {t.isDefault && <span className="badge badge-info">Default</span>}
                  </div>
                  {t.isCustom && allowed && (
                    <div className="row" style={{ gap: 2 }}>
                      <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}><Icon name="edit" /></button>
                      <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}><Icon name="trash" /></button>
                    </div>
                  )}
                </div>
                {t.description && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{t.description}</div>}
                <StageChain stages={t.stages} />
              </div>
            ))}
          </div>
        )}
      {editing && <TimelineEditorModal template={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {saving && project && <SaveTimelineModal project={project} onClose={() => setSaving(false)} />}
    </>
  );
}

// ------------------------------------------------------------------ create / edit

interface Row { key: number; name: string; weight: string }

function TimelineEditorModal({ template, onClose }: { template?: TimelineTemplate; onClose: () => void }) {
  const wid = useWorkspaceId();
  let next = 0;
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [rows, setRows] = useState<Row[]>(() => template
    ? template.stages.map((s, i) => ({ key: next++, name: s, weight: String(template.weights?.[i] ?? 1) }))
    : [{ key: next++, name: '', weight: '1' }, { key: next++, name: '', weight: '1' }]);
  const [counter, setCounter] = useState(rows.length);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), description: description.trim() || undefined, stages: rows.map((r) => ({ name: r.name.trim(), weight: Number(r.weight) })) };
      return template?.id ? projectApi.updateTimelineTemplate(template.id, body) : projectApi.createTimelineTemplate(body);
    },
    onSuccess: async () => { toast(template ? 'Timeline updated.' : 'Timeline created.'); await invalidateWorkspace(wid, 'timeline-templates'); onClose(); },
    onError: (e) => {
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { fe[x.field ?? 'form'] = x.message; });
      setErrors(Object.keys(fe).length ? fe : { form: 'Could not save the timeline.' });
    },
  });

  const setRow = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => setRows((r) => { const j = i + d; if (j < 0 || j >= r.length) return r; const c = [...r]; [c[i], c[j]] = [c[j], c[i]]; return c; });
  const add = () => { setRows((r) => [...r, { key: 1000 + counter, name: '', weight: '1' }]); setCounter((c) => c + 1); };

  const submit = () => {
    const er: Record<string, string> = {};
    if (!name.trim()) er.name = 'Give the timeline a name.';
    if (rows.length === 0) er.stages = 'Add at least one stage.';
    else if (rows.some((r) => !r.name.trim())) er.stages = 'Every stage needs a name.';
    else if (rows.some((r) => !/^\d{1,3}$/.test(r.weight) || Number(r.weight) > 100)) er.stages = 'A stage’s time share is a whole number from 0 to 100.';
    setErrors(er);
    if (!Object.keys(er).length) save.mutate();
  };

  return (
    <Modal size="lg" title={template ? 'Edit timeline' : 'New timeline'} subtitle="The stages, in the order they are worked through." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>{template ? 'Save changes' : 'Create timeline'}</SubmitButton></>}>
      {errors.form && <div className="form-error" role="alert">{errors.form}</div>}
      <div className="form-grid">
        <Field label="Name" required error={errors.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus placeholder="e.g. Agency delivery" /></Field>
        <Field label="Description" error={errors.description}><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="What kind of project is this for?" /></Field>
        <Field label="Stages" required full error={errors.stages}
          hint="Time share is each stage's part of the project's duration when dates are planned. A first stage with 0 (such as “Project Created”) counts as done from the start.">
          <div className="tpl-rows">
            {rows.map((r, i) => (
              <div className="tpl-row" key={r.key}>
                <span className="tpl-n">{i + 1}</span>
                <input className="input" value={r.name} onChange={(e) => setRow(r.key, { name: e.target.value })} maxLength={80} placeholder="Stage name" aria-label={`Stage ${i + 1} name`} />
                <input className="input" inputMode="numeric" value={r.weight} onChange={(e) => setRow(r.key, { weight: e.target.value })} aria-label={`Stage ${i + 1} time share`} title="Time share (0 to 100)" />
                <div className="row tpl-btns" style={{ gap: 0 }}>
                  <button type="button" className="btn-icon" title="Move up" aria-label={`Move stage ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="chevronD" size={15} style={{ transform: 'rotate(180deg)' }} /></button>
                  <button type="button" className="btn-icon" title="Move down" aria-label={`Move stage ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><Icon name="chevronD" size={15} /></button>
                  <button type="button" className="btn-icon danger" title="Remove" aria-label={`Remove stage ${i + 1}`} onClick={() => setRows((x) => x.filter((y) => y.key !== r.key))}><Icon name="trash" size={15} /></button>
                </div>
              </div>
            ))}
            <div><button type="button" className="btn btn-ghost btn-sm" onClick={add}><Icon name="plus" /> Add stage</button></div>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ save a project's stages

function SaveTimelineModal({ project, onClose }: { project: { id: string; name: string }; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(`${project.name} timeline`.slice(0, 80));
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => projectApi.saveTimelineTemplate(project.id, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: async () => { toast('Timeline saved. New projects can start from it.'); await invalidateWorkspace(wid, 'timeline-templates'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? (e.fieldError('name') ?? e.message) : 'Could not save the timeline.'),
  });
  return (
    <Modal size="sm" title="Save as a timeline" subtitle={`Copies the stages of “${project.name}”, in their current order.`} onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!name.trim()) { setError('Give the timeline a name.'); return; } setError(null); save.mutate(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save timeline</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Name" required><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus /></Field>
        <Field label="Description" hint="Each stage keeps its share of the project's duration, worked out from its planned dates."><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
      </div>
    </Modal>
  );
}
