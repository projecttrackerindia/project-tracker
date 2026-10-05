import { useNavigate } from 'react-router-dom';
import { workItemApi } from '../../api/endpoints';
import type { WorkItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, Modal, PageLoader, PriorityBadge } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';

/** Every open action item of the projects in view, grouped by project, overdue first. Choosing one opens that project's action items. */
export function PortfolioActionItems({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const q = useWsQuery(['action-items', 'portfolio'], () => workItemApi.actionItems(true));
  const groups = new Map<string, { name: string; key: string; items: WorkItem[] }>();
  for (const i of q.data ?? []) {
    const id = i.projectId ?? 'none';
    if (!groups.has(id)) groups.set(id, { name: i.projectName ?? 'No project', key: i.projectKey ?? '', items: [] });
    groups.get(id)!.items.push(i);
  }
  const ordered = [...groups.entries()]
    .map(([id, g]) => ({ id, ...g, items: g.items.sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')) }))
    .sort((a, b) => b.items.filter((i) => i.isOverdue).length - a.items.filter((i) => i.isOverdue).length || a.name.localeCompare(b.name));
  const total = q.data?.length ?? 0, overdue = (q.data ?? []).filter((i) => i.isOverdue).length;

  return (
    <Modal title="Action items" subtitle={q.data ? `${total} open${overdue ? ` · ${overdue} overdue` : ''} across ${ordered.length} project${ordered.length === 1 ? '' : 's'}` : undefined} onClose={onClose} size="xl">
      {q.isLoading ? <PageLoader /> : total === 0
        ? <EmptyState icon="checkCircle" title="No open action items" text="Follow-ups added to projects show up here." />
        : (
          <div className="pai">
            {ordered.map((g) => (
              <section key={g.id}>
                <h4>{g.name}{g.key && <em>{g.key}</em>}<span>{g.items.length}</span></h4>
                {g.items.map((i) => (
                  <button key={i.id} type="button" className="pai-row" onClick={() => { onClose(); nav(`/portfolio?project=${i.projectId}&actions=1`); }}>
                    <span className="task-key">{i.key}</span>
                    <span className="pai-title">{i.title}</span>
                    <PriorityBadge priority={i.priority} />
                    <span className="pai-who">{i.assignee ? <><Avatar name={i.assignee.name} size="sm" /> {i.assignee.name}</> : <span className="muted">Unassigned</span>}</span>
                    <span className={`pai-due ${i.isOverdue ? 'late' : ''}`}>{i.dueDate ? formatDate(i.dueDate) : 'No date'}</span>
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
