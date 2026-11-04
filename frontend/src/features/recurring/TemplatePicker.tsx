import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { CalmSheet } from '../../components/calm';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { templateApi, type TemplateKind, type WorkTemplate } from './api';
import './recurring.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const facts = (t: WorkTemplate) => [
  t.sectionCount ? `${t.sectionCount} section${t.sectionCount === 1 ? '' : 's'}` : null,
  `${t.taskCount} task${t.taskCount === 1 ? '' : 's'}`,
  t.durationDays ? `${t.durationDays} days` : null,
].filter(Boolean).join(' · ');

/**
 * "From template…" in + New: a searchable list of the workspace's project and task templates; picking one asks only what it needs (a name and a
 * start date for a project; the project and a start date for a task) and every date in the template shifts to that start.
 */
export function TemplatePicker({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { projectId: string | null; taskIds: string[] }) => void }) {
  const [kind, setKind] = useState<TemplateKind>('project');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<WorkTemplate | null>(null);
  const [name, setName] = useState('');
  const [start, setStart] = useState(today());
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const list = useWsQuery(['templates', kind], () => templateApi.list(kind), { retry: false });
  const projects = useWsQuery(['projects', 'template-picker'], () => projectApi.list({ pageSize: 100 }), { enabled: kind === 'task', retry: false });
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (list.data ?? []).filter((t) => !term || t.name.toLowerCase().includes(term) || (t.description ?? '').toLowerCase().includes(term));
  }, [list.data, q]);

  const make = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      const r = picked.kind === 'project'
        ? await templateApi.createProject(picked.id, { name: name.trim() || picked.name, startDate: start })
        : await templateApi.createTask(picked.id, { projectId, startDate: start });
      toast(picked.kind === 'project' ? 'Project created from the template.' : `${r.taskIds.length} task${r.taskIds.length === 1 ? '' : 's'} created.`);
      onCreated(r);
    } catch (e) { toast(errText(e, 'Could not create from the template.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <CalmSheet open onClose={onClose} width={560} label="New" title="From template"
      sub={picked ? 'Every date in it moves with the start date.' : 'Start from a project or task your team saved.'}>
      <div className="tp-body" data-testid="template-picker">
        {!picked ? (
          <>
            <div className="tp-seg" role="tablist" aria-label="Template kind">
              {(['project', 'task'] as const).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{k === 'project' ? 'Projects' : 'Tasks'}</button>
              ))}
            </div>
            <input className="tp-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates" aria-label="Search templates" autoFocus />
            <div className="tp-list" role="listbox" aria-label="Templates">
              {list.isLoading && <p className="tp-empty">Loading…</p>}
              {!list.isLoading && shown.length === 0 && (
                <p className="tp-empty">{q ? 'No template matches.' : `No ${kind} templates yet. Open a ${kind} and choose “Save as template”.`}</p>
              )}
              {shown.map((t) => (
                <button key={t.id} type="button" role="option" aria-selected={false} className="tp-item" onClick={() => { setPicked(t); setName(t.kind === 'project' ? t.name : ''); }}>
                  <span className={`tp-tile ${t.kind}`} aria-hidden="true">{t.kind === 'project' ? '▤' : '✓'}</span>
                  <span className="tp-text"><b>{t.name}</b><small>{[facts(t), t.description].filter(Boolean).join(' · ')}</small></span>
                  <span className="tp-chev" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <form className="tp-form" onSubmit={(e) => { e.preventDefault(); void make(); }}>
            <button type="button" className="tp-back" onClick={() => setPicked(null)}>‹ All templates</button>
            <div className="tp-picked"><span className={`tp-tile ${picked.kind}`} aria-hidden="true">{picked.kind === 'project' ? '▤' : '✓'}</span><span className="tp-text"><b>{picked.name}</b><small>{facts(picked)}</small></span></div>
            {picked.kind === 'project'
              ? <label className="tp-field"><span>Project name</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required /></label>
              : (
                <label className="tp-field"><span>Project</span>
                  <select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>
                    <option value="" disabled>Choose a project</option>
                    {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
                  </select>
                </label>
              )}
            <label className="tp-field"><span>Starts</span><input type="date" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
            <div className="tp-acts">
              <button type="button" className="rp-btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="rp-btn primary" disabled={busy || (picked.kind === 'task' && !projectId)}>{busy ? 'Creating…' : 'Create'}</button>
            </div>
          </form>
        )}
      </div>
    </CalmSheet>
  );
}
