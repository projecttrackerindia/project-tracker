import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi, projectApi, teamApi } from '../../api/endpoints';
import type { DocumentType, DocumentVisibility } from '../../api/types';
import { Select } from '../../components/Select';
import { Field, Modal, PageLoader } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SectionEditor } from './SectionEditor';
import { TypeChip, VISIBILITY } from './docUi';

const PER_STEP = 4;
const hasText = (json: string | undefined) => !!json && /"text":"[^"]*\S/.test(json) || (!!json && /"rows":\[\s*\{/.test(json));

/**
 * Create a document in a few steps: what it is and where it lives, then its sections a handful at a time (a BRD is five steps in all), then a
 * look over what was written. Nothing has to be filled in: every section can be written later.
 */
export function DocumentWizard({ onClose, projectId, onCreated }: { onClose: () => void; projectId?: string; onCreated: (id: string) => void }) {
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const canSeeTeams = useModule('teams') > 0 && !personal;
  const types = useWsQuery(['document-types'], documentApi.types);
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }), { enabled: !projectId });
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: canSeeTeams });

  const [step, setStep] = useState(0);
  const [typeId, setTypeId] = useState('');
  const [title, setTitle] = useState('');
  const [where, setWhere] = useState<'project' | 'general'>(projectId || personal ? 'project' : 'project');
  const [project, setProject] = useState(projectId ?? '');
  const [visibility, setVisibility] = useState<DocumentVisibility>('Project');
  const [teamId, setTeamId] = useState('');
  const [tags, setTags] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; limit: boolean } | null>(null);

  const type: DocumentType | undefined = types.data?.find((t) => t.id === typeId);
  const groups = useMemo(() => {
    const s = type?.sections ?? [];
    return Array.from({ length: Math.ceil(s.length / PER_STEP) }, (_, i) => s.slice(i * PER_STEP, (i + 1) * PER_STEP));
  }, [type]);
  const last = 1 + groups.length;       // the review step
  const total = last + 1;

  const projectVisibilities: DocumentVisibility[] = ['Project', 'Private'];
  const generalVisibilities: DocumentVisibility[] = [...(canSeeTeams ? ['Team' as const] : []), 'Organization', 'Private'];
  const allowed = where === 'project' ? projectVisibilities : generalVisibilities;
  const chooseWhere = (w: 'project' | 'general') => { setWhere(w); setVisibility(w === 'project' ? 'Project' : canSeeTeams ? 'Team' : 'Organization'); };

  const basicsError = !typeId ? 'Choose what kind of document this is.' : !title.trim() ? 'Give the document a title.'
    : where === 'project' && !project ? 'Choose the project this document belongs to.'
    : where === 'general' && visibility === 'Team' && !teamId ? 'Choose the team that can see it.' : null;

  const create = useMutation({
    mutationFn: () => documentApi.create({
      title: title.trim(), typeId, projectId: where === 'project' ? project : null, teamId: where === 'general' && visibility === 'Team' ? teamId : null, visibility,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
      sections: Object.entries(values).filter(([, v]) => hasText(v)).map(([key, content]) => ({ key, content })),
    }),
    onSuccess: (d) => { toast(`${d.item.key} created.`); invalidateWorkspace(wid, 'documents'); invalidateWorkspace(wid, 'linked-documents'); onCreated(d.item.id); },
    onError: (e) => setError({ message: e instanceof ApiError ? e.message : 'Could not create the document.', limit: e instanceof ApiError && e.code === 'PLAN_LIMIT_REACHED' }),
  });

  const next = () => { if (step === 0 && basicsError) { setError({ message: basicsError, limit: false }); return; } setError(null); setStep((s) => s + 1); };
  const filled = type?.sections.filter((s) => hasText(values[s.key])).length ?? 0;
  const where_ = where === 'project' ? (projectId ? 'this project' : projects.data?.items.find((p) => p.id === project)?.name ?? 'a project') : visibility === 'Team' ? teams.data?.find((t) => t.id === teamId)?.name ?? 'a team' : 'the organization';

  return (
    <Modal title="New document" subtitle={`Step ${step + 1} of ${type ? total : '…'}`} size="xl" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" type="button" onClick={step === 0 ? onClose : () => { setError(null); setStep(step - 1); }}>{step === 0 ? 'Cancel' : 'Back'}</button>
        {step < last
          ? <button className="btn btn-primary" type="button" onClick={next} disabled={!types.data}>{step === last - 1 ? 'Review' : 'Next'} <Icon name="arrowRight" size={15} /></button>
          : <button className="btn btn-primary" type="button" onClick={() => { setError(null); create.mutate(); }} disabled={create.isPending}>{create.isPending && <span className="spinner" />}Create document</button>}
      </>}>
      {!types.data ? <PageLoader /> : (
        <div className="wiz">
          <ol className="wiz-steps" aria-label="Progress">
            {Array.from({ length: type ? total : 2 }, (_, i) => <li key={i} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}><span>{i < step ? '✓' : i + 1}</span></li>)}
          </ol>
          {error && (
            <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error.message}{error.limit && <> <Link to="/settings/billing" onClick={onClose}>See plans</Link></>}</div></div>
          )}

          {step === 0 && (
            <div className="wiz-basics">
              <Field label="What are you writing?" required>
                <div className="doc-types" role="radiogroup" aria-label="Document type">
                  {types.data.map((t) => (
                    <button type="button" key={t.id} role="radio" aria-checked={t.id === typeId} className={`doc-type${t.id === typeId ? ' on' : ''}`} onClick={() => setTypeId(t.id)}>
                      <TypeChip doc={{ typeColor: t.color, typeIcon: t.icon, typeName: t.name }} size={30} />
                      <span><b>{t.name}</b><small>{t.description}</small></span>
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Title" required><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Employee portal integration" /></Field>
              {!projectId && (
                <Field label="Where does it belong?">
                  <div className="seg" role="radiogroup" aria-label="Where it belongs">
                    <button type="button" role="radio" aria-checked={where === 'project'} className={where === 'project' ? 'on' : ''} onClick={() => chooseWhere('project')}>A project</button>
                    <button type="button" role="radio" aria-checked={where === 'general'} className={where === 'general' ? 'on' : ''} onClick={() => chooseWhere('general')}>General (no project)</button>
                  </div>
                </Field>
              )}
              {where === 'project' && !projectId && (
                <Field label="Project" required>
                  <Select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
                    <option value="">Choose a project…</option>
                    {projects.data?.items.filter((p) => p.status !== 'Archived').map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
                  </Select>
                </Field>
              )}
              <Field label="Who can open it?" hint={VISIBILITY[visibility].hint}>
                <Select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value as DocumentVisibility)} aria-label="Visibility">
                  {allowed.map((v) => <option key={v} value={v}>{VISIBILITY[v].label}</option>)}
                </Select>
              </Field>
              {where === 'general' && visibility === 'Team' && (
                <Field label="Team" required>
                  <Select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team"><option value="">Choose a team…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
                </Field>
              )}
              <Field label="Tags" hint="Separate with commas. They help people find it."><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="payroll, integration" /></Field>
            </div>
          )}

          {type && step >= 1 && step < last && groups[step - 1].map((s) => (
            <SectionEditor key={s.key} section={s} template={s} value={values[s.key] ?? ''} onChange={(v) => setValues((x) => ({ ...x, [s.key]: v }))} />
          ))}

          {type && step === last && (
            <div className="wiz-review">
              <h3>{title.trim()}</h3>
              <dl className="doc-facts">
                <div><dt>Kind</dt><dd><TypeChip doc={{ typeColor: type.color, typeIcon: type.icon, typeName: type.name }} size={22} /> {type.name}</dd></div>
                <div><dt>Belongs to</dt><dd>{where_}</dd></div>
                <div><dt>Visible to</dt><dd>{VISIBILITY[visibility].label} — {VISIBILITY[visibility].hint}</dd></div>
                {tags.trim() && <div><dt>Tags</dt><dd>{tags}</dd></div>}
              </dl>
              <p className="muted">{filled} of {type.sections.length} sections have content. You can write the rest after it is created: it starts as a draft only you and the people allowed above can open.</p>
              <ul className="wiz-empty">{type.sections.map((s) => <li key={s.key} className={hasText(values[s.key]) ? 'ok' : ''}>{hasText(values[s.key]) ? '✓' : '○'} {s.title}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
