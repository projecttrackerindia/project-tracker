import type { IconName } from '../../components/Icon';
import type { AiMemory } from '../ai/aiApi';

/** The groups of memories, in the order a person thinks of them: mine, my teams', everyone's. */
export function groupMemories(items: AiMemory[]): { key: string; label: string; icon: IconName; items: AiMemory[]; forgetAll?: 'person' | 'workspace' }[] {
  const mine = items.filter((m) => m.scope === 'Person');
  const teams = new Map<string, AiMemory[]>();
  for (const m of items.filter((x) => x.scope === 'Team')) teams.set(m.teamName ?? 'Team', [...(teams.get(m.teamName ?? 'Team') ?? []), m]);
  const workspace = items.filter((m) => m.scope === 'Workspace');
  return [
    ...(mine.length ? [{ key: 'you', label: 'You', icon: 'user' as const, items: mine, forgetAll: 'person' as const }] : []),
    ...[...teams.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, rows]) => ({ key: `team-${name}`, label: `${name} team`, icon: 'users' as const, items: rows })),
    ...(workspace.length ? [{ key: 'workspace', label: 'Whole workspace', icon: 'building' as const, items: workspace, forgetAll: 'workspace' as const }] : []),
  ];
}
