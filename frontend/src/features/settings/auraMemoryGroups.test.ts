import { describe, expect, it } from 'vitest';
import type { AiMemory } from '../ai/aiApi';
import { groupMemories } from './auraMemoryGroups';

const m = (id: string, scope: AiMemory['scope'], teamName: string | null = null): AiMemory => ({
  id, scope, text: `note ${id}`, source: 'Said', teamId: teamName ? `t-${teamName}` : null, teamName, createdAt: '2027-01-04T10:00:00Z', lastUsedAt: null, canDelete: true,
});

describe('groupMemories', () => {
  it('lists yours first, then each team by name, then the workspace, and leaves out empty groups', () => {
    const groups = groupMemories([m('1', 'Workspace'), m('2', 'Team', 'Platform'), m('3', 'Person'), m('4', 'Team', 'Design'), m('5', 'Team', 'Platform')]);
    expect(groups.map((g) => g.label)).toEqual(['You', 'Design team', 'Platform team', 'Whole workspace']);
    expect(groups[2].items.map((x) => x.id)).toEqual(['2', '5']);
    expect(groups[0].forgetAll).toBe('person');
    expect(groups[3].forgetAll).toBe('workspace');
  });

  it('has no groups when nothing is remembered', () => expect(groupMemories([])).toEqual([]));
});
