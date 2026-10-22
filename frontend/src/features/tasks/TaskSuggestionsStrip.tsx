import { taskApi } from '../../api/endpoints';
import type { Priority, TaskSuggestions } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { formatDate } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import './tasks.css';

export interface SuggestionTargets { assigneeId: string; estimatedHours: string; dueDate: string; priority: Priority }

interface Chip { key: keyof SuggestionTargets; icon: IconName; label: string; why: string; value: string; current: string }

/**
 * Suggestions for a new task, shown under its title as the person types: who fits, how long similar work took, a due date and the usual
 * priority. They come from the workspace's own finished work (no AI call, no credits). Nothing is filled in until the person clicks Use;
 * "Use all" fills only the fields still empty, so nothing they chose is overwritten.
 */
export function TaskSuggestionsStrip({ projectId, title, values, onUse }: {
  projectId: string; title: string; values: SuggestionTargets; onUse: (patch: Partial<SuggestionTargets>) => void;
}) {
  const asked = useDebounced(title.trim(), 450);
  const q = useWsQuery(['task-suggest', projectId, asked], () => taskApi.suggest(projectId, asked), { enabled: !!projectId && asked.length >= 4, staleTime: 60_000 });
  const s: TaskSuggestions | undefined = q.data;
  if (!s || asked.length < 4) return null;

  const chips: Chip[] = [];
  const best = s.assignees[0];
  if (best) chips.push({ key: 'assigneeId', icon: 'user', label: best.name, why: best.why, value: best.userId, current: values.assigneeId });
  if (s.estimate != null) {
    const range = s.estimateLow != null && s.estimateHigh != null && s.estimateLow !== s.estimateHigh ? `${s.estimateLow}–${s.estimateHigh} h` : `${s.estimate} h`;
    chips.push({ key: 'estimatedHours', icon: 'clock', label: range, why: s.estimateWhy ?? '', value: String(s.estimate), current: values.estimatedHours });
  }
  if (s.dueDate) chips.push({ key: 'dueDate', icon: 'calendar', label: `Due ${formatDate(s.dueDate)}`, why: s.dueWhy ?? '', value: s.dueDate, current: values.dueDate });
  if (s.priority) chips.push({ key: 'priority', icon: 'flag', label: s.priority, why: s.priorityWhy ?? '', value: s.priority, current: values.priority });
  const open = chips.filter((c) => c.current !== c.value);
  if (!open.length) return null;
  const empty = open.filter((c) => !c.current || (c.key === 'priority' && c.current === 'Medium'));

  return (
    <div className="tsg-strip field full" role="group" aria-label="Suggestions from similar work">
      <div className="tsg-strip-head">
        <span><Icon name="sparkle" size={13} /> From similar work{s.similar.length ? `: ${s.similar.map((x) => x.key).join(', ')}` : ''}</span>
        {empty.length > 1 && <button type="button" className="mb-link" onClick={() => onUse(Object.fromEntries(empty.map((c) => [c.key, c.value])))}>Use all</button>}
      </div>
      <div className="tsg-chips">
        {open.map((c) => (
          <button key={c.key} type="button" className="tsg-chip" title={c.why} onClick={() => onUse({ [c.key]: c.value } as Partial<SuggestionTargets>)}>
            <Icon name={c.icon} size={13} /><b>{c.label}</b><small>{c.why}</small><em>Use</em>
          </button>
        ))}
      </div>
    </div>
  );
}
