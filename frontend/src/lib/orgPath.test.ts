import { describe, expect, it } from 'vitest';
import { firstSegment, orgFromPath, inOrg, RESERVED_SEGMENTS } from './orgPath';
import type { Workspace } from '../api/types';

const ws = (slug: string): Workspace => ({ id: slug, name: slug, slug, type: 'Organization', role: 'Owner', description: null, planCode: 'FREE', memberCount: 1 });

describe('firstSegment', () => {
  it('reads the first path segment, lowercased', () => {
    expect(firstSegment('/Acme-Bank/projects/1')).toBe('acme-bank');
    expect(firstSegment('/')).toBe('');
    expect(firstSegment('')).toBe('');
  });
});

describe('orgFromPath', () => {
  const workspaces = [ws('acme'), ws('fivestar')];

  it('finds the workspace whose slug matches the first segment, case-insensitively', () => {
    expect(orgFromPath('/acme/projects/1', workspaces)?.slug).toBe('acme');
    expect(orgFromPath('/FiveStar/chat', workspaces)?.slug).toBe('fivestar');
  });

  it('never matches a reserved top-level segment, even if a workspace happened to share the name', () => {
    expect(orgFromPath('/settings/billing', workspaces)).toBeUndefined();
    expect(orgFromPath('/projects', [ws('projects')])).toBeUndefined();
  });

  it('is undefined for a workspace the person does not belong to', () => {
    expect(orgFromPath('/someone-elses-org/projects', workspaces)).toBeUndefined();
  });

  it('every reserved segment really is reserved (guards RESERVED_SEGMENTS against an accidental edit)', () => {
    expect(RESERVED_SEGMENTS.has('projects')).toBe(true);
    expect(RESERVED_SEGMENTS.has('settings')).toBe(true);
    expect(RESERVED_SEGMENTS.has('acme')).toBe(false);
  });
});

describe('inOrg', () => {
  it('prefixes a path with the organization slug', () => {
    expect(inOrg('acme', '/projects/1')).toBe('/acme/projects/1');
  });
  it('adds the missing leading slash if the path did not have one', () => {
    expect(inOrg('acme', 'projects/1')).toBe('/acme/projects/1');
  });
});
