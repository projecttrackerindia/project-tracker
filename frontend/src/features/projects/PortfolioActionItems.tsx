import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectApi, statusApi, workItemApi } from '../../api/endpoints';
import type { WorkItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, Field, Modal, PageLoader, PriorityBadge } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { ItemForm } from './ActionItemsPanel';

type View = 'open' | 'done' | 'all';

/**
 * The action items of every project in view: Open / Completed / All, grouped by project with overdue first, and a way to add one to any
 * project without leaving the Portfolio. Choosing an item opens that project's action items.
 */
export function PortfolioActionItems({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const canAdd = useCan('tasks.create');
  const [view, setView] = useState<View>('open');
  const [adding, setAdding] = useState(false);
  const [projectId, setProjectId] = useState('');
  const q = useWsQuery(['action-items', 'portfolio'], () => workItemApi.actionItems(false));
  const { teamId } = useTeamLens();
  const groups = useWsQuery(['project-status', 'groups', teamId], () => statusApi.groups(teamId));
  const projects = useMemo(() => (groups.data ?? []).flatMap((g) => g.projects).filter((p) => p.status !== 'Completed' && p.status !== 'Cancelled' && p.status !== 'Archived'), [groups.data]);
  const detail = useWsQuery(['project', projectId], () => projectApi.get(projectId), { enabled: !!projectId });
  const people = useMemo(() => (detail.data?.members ?? []).filter((m) => m.role !== 'Guest').map((m) => ({ id: m.userId, name: m.name })), [detail.data]);

  const all = q.data ?? [];
  const isDone = (i: WorkItem) => i.category === 'Done';
  const shown = all.filter((i) => view === 'all' || (view === 'open' ? !isDone(i) : isDone(i)));
  const byProject = new Map<string, { name: string; key: string; items: WorkItem[] }>();
  for (const i of shown) {
    const id = i.projectId ?? 'none';
    if (!byProject.has(id)) byProject.set(id, { name: i.projectName ?? 'No project', key: i.projectKey ?? '', items: [] });
    byProject.get(id)!.items.push(i);
  }
  const ordered = [...byProject.entries()]
    .map(([id, g]) => ({ id, ...g, items: g.items.sort((a, b) => Number(isDone(a)) - Number(isDone(b)) || Number(b.isOverdue) - Number(a.isOverdue) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')) }))
    .sort((a, b) => b.items.filter((i) => i.isOverdue).length - a.items.filter((i) => i.isOverdue).length || a.name.localeCompare(b.name));
  const open = all.filter((i) => !isDone(i)).length, done = all.length - open, overdue = all.filter((i) => i.isOverdue && !isDone(i)).length;

  const added = () => { setAdding(false); setProjectId(''); void invalidateWorkspace(wid, 'action-items'); void invalidateWorkspace(wid, 'project-status'); };

  return (
    <Modal title="Action items" subtitle={q.data ? `${open} open${overdue ? ` · ${overdue} overdue` : ''} · ${done} completed, across ${projects.length} project${projects.length === 1 ? '' : 's'}` : undefined} onClose={onClose} size="xl">
      <div className="pai-toolbar">
        <div className="seg" role="group" aria-label="Show action items">
          {([['open', 'Open', open], ['done', 'Completed', done], ['all', 'All', all.length]] as const).map(([id, label, n]) => (
            <button key={id} type="button" className={view === id ? 'on' : ''} aria-pressed={view === id} onClick={() => setView(id)}>{label} <em>{n}</em></button>
          ))}
        </div>
        {canAdd && projects.length > 0 && <button type="button" className="btn btn-primary btn-sm" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><Icon name="plus" size={14} /> Add action item</button>}
      </div>

      {adding && (
        <div className="pai-add">
          <Field label="Project" required>
            <Select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              <option value="">Choose the project…</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.key})</option>)}
            </Select>
          </Field>
          {projectId && (detail.isLoading ? <PageLoader /> : <ItemForm key={projectId} people={people} projectId={projectId} onDone={added} onCancel={() => setAdding(false)} />)}
        </div>
      )}

      {q.isLoading ? <PageLoader /> : shown.length === 0
        ? <EmptyState icon="checkCircle" title={view === 'done' ? 'Nothing completed yet' : 'No open action items'} text="Follow-ups added to projects show up here." />
        : (
          <div className="pai">
            {ordered.map((g) => (
              <section key={g.id}>
                <h4>{g.name}{g.key && <em>{g.key}</em>}<span>{g.items.length}</span></h4>
                {g.items.map((i) => (
                  <button key={i.id} type="button" className={`pai-row ${isDone(i) ? 'done' : ''}`} onClick={() => { onClose(); nav(`/portfolio?project=${i.projectId}&actions=1`); }}>
                    <span className="task-key">{i.key}</span>
                    <span className="pai-title">{i.title}</span>
                    <PriorityBadge priority={i.priority} />
                    <span className="pai-who">{i.assignee ? <><Avatar name={i.assignee.name} size="sm" /> {i.assignee.name}</> : <span className="muted">Unassigned</span>}</span>
                    <span className={`pai-due ${i.isOverdue && !isDone(i) ? 'late' : ''}`}>{isDone(i) ? 'Completed' : i.dueDate ? formatDate(i.dueDate) : 'No date'}</span>
                    <Icon name="chevronR" size={14} />
                  </button>
                ))}
              </section>
            ))}
          </div>
        )}
    </Modal>
  );
}
