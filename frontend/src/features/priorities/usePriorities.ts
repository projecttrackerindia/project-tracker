import { priorityApi } from '../../api/endpoints';
import type { Priority, PriorityInfo } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';

const DEFAULTS: PriorityInfo[] = [
  { level: 'Critical', name: 'Critical', color: '#ef4444', isCustom: false }, { level: 'High', name: 'High', color: '#f59e0b', isCustom: false },
  { level: 'Medium', name: 'Medium', color: '#38bdf8', isCustom: false }, { level: 'Low', name: 'Low', color: '#94a3b8', isCustom: false },
];

/** This workspace's names and colours for the four priority levels (falls back to the standard ones while loading). */
export function usePriorities() {
  const q = useWsQuery(['priorities'], priorityApi.get, { staleTime: 60_000 });
  const list = q.data ?? DEFAULTS;
  return { list, info: (p: Priority) => list.find((x) => x.level === p) ?? DEFAULTS.find((x) => x.level === p)!, isLoading: q.isLoading };
}
