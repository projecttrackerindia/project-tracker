import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { planningApi, taskApi } from '../../api/endpoints';
import type { DependencyLink, DependencyType } from '../../api/types';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Select } from '../../components/Select';

export const DEPENDENCY_TYPES: { id: DependencyType; label: string; hint: string }[] = [
  { id: 'FinishToStart', label: 'Finish → Start', hint: 'This task cannot start until the other one is finished.' },
  { id: 'StartToStart', label: 'Start → Start', hint: 'This task cannot start until the other one has started.' },
  { id: 'FinishToFinish', label: 'Finish → Finish', hint: 'This task cannot finish until the other one is finished.' },
  { id: 'StartToFinish', label: 'Start → Finish', hint: 'This task cannot finish until the other one has started.' },
];
const typeLabel = (t: DependencyType) => DEPENDENCY_TYPES.find((x) => x.id === t)?.label ?? t;

/** What a task waits for, and what waits for it. Links are checked on the server: loops and other projects are refused. */
export function Dependencies({ taskId, projectId, canEdit }: { taskId: string; projectId: string; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [picked, setPicked] = useState('');
  const [type, setType] = useState<DependencyType>('FinishToStart');
  const [busy, setBusy] = useState(false);

  const deps = useWsQuery(['task', taskId, 'dependencies'], () => planningApi.dependencies(taskId));
  const candidates = useWsQuery(['project', projectId, 'tasks', 'options'], () => taskApi.listForProject(projectId, { pageSize: 200, includeSubtasks: true }), { enabled: canEdit });
  const d = deps.data;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [wid, 'task', taskId] });
    void qc.invalidateQueries({ queryKey: [wid, 'project', projectId] });
    void qc.invalidateQueries({ queryKey: [wid, 'tasks'] });
  };

  const add = async () => {
    if (!picked) return;
    setBusy(true);
    try { await planningApi.addDependency(taskId, { dependsOnTaskId: picked, type }); setPicked(''); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add the dependency.', 'error'); }
    finally { setBusy(false); }
  };
  const remove = async (link: DependencyLink) => {
    try { await planningApi.removeDependency(taskId, link.id); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove the dependency.', 'error'); }
  };

  const taken = new Set([taskId, ...(d?.blockedBy.map((x) => x.task.id) ?? [])]);
  const options = (candidates.data?.items ?? []).filter((t) => !taken.has(t.id));
  const count = (d?.blockedBy.length ?? 0) + (d?.blocks.length ?? 0);

  return (
    <div className="form-section">
      <h4 className="section-title">Dependencies {count > 0 && <span className="kb-count">{count}</span>}</h4>
      {d?.blockedReason && <div className="form-warn dep-warn" role="status"><Icon name="lock" size={15} /><span>{d.blockedReason}</span></div>}

      {d && d.blockedBy.length > 0 && (
        <div className="dep-group">
          <div className="dep-label">Waiting for</div>
          {d.blockedBy.map((l) => (
            <div className={`dep-row ${l.satisfied ? 'ok' : 'wait'}`} key={l.id}>
              <span className="dep-state" title={l.satisfied ? 'Ready' : 'Not ready yet'}><Icon name={l.satisfied ? 'checkCircle' : 'clock'} size={15} /></span>
              <div className="dep-main"><b>{l.task.key}</b> {l.task.title}<span className="dep-meta">{typeLabel(l.type)} · {l.task.statusName}</span></div>
              {canEdit && <button type="button" className="btn-icon danger" title="Remove dependency" aria-label={`Remove dependency on ${l.task.key}`} onClick={() => void remove(l)}><Icon name="close" size={14} /></button>}
            </div>
          ))}
        </div>
      )}
      {d && d.blocks.length > 0 && (
        <div className="dep-group">
          <div className="dep-label">Blocking</div>
          {d.blocks.map((l) => (
            <div className="dep-row" key={l.id}>
              <span className="dep-state"><Icon name="git" size={15} /></span>
              <div className="dep-main"><b>{l.task.key}</b> {l.task.title}<span className="dep-meta">{typeLabel(l.type)} · {l.task.statusName}</span></div>
            </div>
          ))}
        </div>
      )}
      {d && count === 0 && <p className="muted" style={{ fontSize: 12.5, margin: '4px 0 8px' }}>No dependencies. Add one if this task cannot start or finish before another does.</p>}

      {canEdit && (
        <div className="dep-add">
          <Select className="select" value={picked} onChange={(e) => setPicked(e.target.value)} aria-label="Task this one depends on">
            <option value="">Depends on…</option>{options.map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title}</option>)}
          </Select>
          <Select className="select" value={type} onChange={(e) => setType(e.target.value as DependencyType)} aria-label="Type of dependency" title={DEPENDENCY_TYPES.find((x) => x.id === type)?.hint}>
            {DEPENDENCY_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </Select>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!picked || busy} onClick={() => void add()}>{busy && <span className="spinner" />}<Icon name="plus" /> Add</button>
        </div>
      )}
    </div>
  );
}
