import { describe, expect, it } from 'vitest';
import { elapsed, fillMacro, slaRing } from './deskLogic';
import { draftToFlow, emptyFlow, flowToInput, RECIPES } from './automationFlow';

describe('slaRing', () => {
  const start = '2026-10-01T00:00:00Z', due = '2026-10-01T10:00:00Z';
  const at = (h: number) => Date.parse(start) + h * 3600_000;
  it('is green under 75%', () => expect(slaRing(start, due, 'OnTrack', at(5))).toEqual({ used: 0.5, tone: 'ok' }));
  it('turns amber at 75%', () => expect(slaRing(start, due, 'OnTrack', at(7.5)).tone).toBe('warn'));
  it('is red once breached', () => expect(slaRing(start, due, 'OnTrack', at(11))).toEqual({ used: 1, tone: 'late' }));
  it('trusts the server state', () => expect(slaRing(start, due, 'Breached', at(1)).tone).toBe('late'));
});

describe('desk helpers', () => {
  it('formats elapsed time', () => expect(elapsed('2026-10-01T00:00:00Z', Date.parse('2026-10-02T01:02:03Z'))).toBe('1d 01:02:03'));
  it('fills macros with the first name', () => expect(fillMacro('Hi {name}', 'Ravi Kumar')).toBe('Hi Ravi'));
});

describe('automation flow', () => {
  it('only sends conditions the trigger has', () => {
    const f = { ...emptyFlow(), trigger: 'StatusChanged' as const, whenStatusCategory: 'Done' as const };
    const input = flowToInput({ ...f, whenPriority: 'High' });
    expect(input.whenStatusCategory).toBe('Done');
    expect(input.whenPriority).toBeNull();
    expect(input.triggerDays).toBeNull();
    expect(input.action).toBe('Notify');
    expect(input.moreActions).toEqual([]);
  });
  it('sends every AND condition, drops ticket-only ones on tasks, and keeps drafts off', () => {
    const f = RECIPES.find((t) => t.id === 'oncall')!.flow!();
    const input = flowToInput({ ...f, conditions: [...f.conditions, { field: 'businessHours' }, { field: 'noReply', minutes: 30 }] });
    expect(input.trigger).toBe('TicketCreated');
    expect(input.conditions?.map((c) => c.field)).toEqual(['priority', 'businessHours', 'noReply']);
    expect(input.isDraft).toBe(true);
    expect(input.isEnabled).toBe(false);
    expect(input.moreActions[0].action).toBe('PostToChannel');
    const onTask = flowToInput({ ...f, trigger: 'TaskCreated', conditions: [{ field: 'noReply', minutes: 30 }] });
    expect(onTask.conditions).toEqual([]);
  });
  it('maps an AI draft to steps', () => {
    const f = draftToFlow({ name: 'x', trigger: 'Overdue', triggerDays: 2, whenPriority: null, whenStatusCategory: null, reason: '',
      steps: [{ action: 'SetPriority', priority: null, statusCategory: null, target: null, userId: null, text: null }, { action: 'SetAssignee', priority: null, statusCategory: null, target: null, userId: null, text: null }] });
    expect(f.steps[0].actionPriority).toBe('High');
    expect(f.steps[1].actionTarget).toBe('Reporter');
    expect(flowToInput(f).moreActions).toHaveLength(1);
  });
});
