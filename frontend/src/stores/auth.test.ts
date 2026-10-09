import { describe, expect, it } from 'vitest';
import { hasPermission, entitlementOf, moduleLevelOf, isPersonalCtx } from './auth';
import type { AppContext, CurrentWorkspace } from '../api/types';

const current = (over: Partial<CurrentWorkspace> = {}): CurrentWorkspace => ({
  id: 'w1', name: 'Fivestar', slug: 'fivestar', type: 'Organization', role: 'Owner', description: null,
  permissions: ['tasks.create', 'projects.edit'], plan: { code: 'BUSINESS', name: 'Business', status: 'Active', trialEnd: null, periodEnd: null, cancelAtPeriodEnd: false, downgraded: false },
  entitlements: { PROJECT_LIMIT: 10, AUDIT_LOG: 1 }, modules: { tasks: 2, work: 0 },
  ...over,
});
const ctx = (cur: CurrentWorkspace | null): AppContext => ({ user: {} as AppContext['user'], workspaces: [], current: cur, fingerprint: '' });

describe('hasPermission', () => {
  it('is true only for a permission actually granted', () => {
    expect(hasPermission(ctx(current()), 'tasks.create')).toBe(true);
    expect(hasPermission(ctx(current()), 'tasks.delete')).toBe(false);
  });
  it('is false with no workspace or no context at all', () => {
    expect(hasPermission(ctx(null), 'tasks.create')).toBe(false);
    expect(hasPermission(null, 'tasks.create')).toBe(false);
    expect(hasPermission(undefined, 'tasks.create')).toBe(false);
  });
});

describe('entitlementOf', () => {
  it('reads a known entitlement and defaults an unknown one to 0', () => {
    expect(entitlementOf(ctx(current()), 'PROJECT_LIMIT')).toBe(10);
    expect(entitlementOf(ctx(current()), 'SOMETHING_UNSET')).toBe(0);
  });
  it('is 0 with no workspace', () => {
    expect(entitlementOf(ctx(null), 'PROJECT_LIMIT')).toBe(0);
  });
});

describe('moduleLevelOf', () => {
  it('reads a module level and defaults a missing one to 0 (no access)', () => {
    expect(moduleLevelOf(ctx(current()), 'tasks')).toBe(2);
    expect(moduleLevelOf(ctx(current()), 'work')).toBe(0);
    expect(moduleLevelOf(ctx(current()), 'projects')).toBe(0);
  });
  it('is 0 if the workspace has no modules map at all', () => {
    expect(moduleLevelOf(ctx(current({ modules: undefined as unknown as Record<string, number> })), 'tasks')).toBe(0);
  });
});

describe('isPersonalCtx', () => {
  it('is true only for a Personal workspace', () => {
    expect(isPersonalCtx(ctx(current({ type: 'Personal' })))).toBe(true);
    expect(isPersonalCtx(ctx(current({ type: 'Organization' })))).toBe(false);
    expect(isPersonalCtx(ctx(null))).toBe(false);
  });
});
