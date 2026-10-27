import { describe, expect, it } from 'vitest';
import { envLabels, legacyTarget, topicOf } from './nav';

describe('legacyTarget', () => {
  it('leaves new addresses alone', () => {
    expect(legacyTarget('/library', '')).toBeNull();
    expect(legacyTarget('/library', '?new=1&title=x')).toBeNull();
    expect(legacyTarget('/library/p/abc', '?p=x')).toBeNull();
  });
  it('maps DocTracker views', () => {
    expect(legacyTarget('/library/docs', '?view=security')).toBe('/library/security');
    expect(legacyTarget('/library/docs', '?view=home')).toBe('/library');
    expect(legacyTarget('/library/docs', '')).toBe('/library');
    expect(legacyTarget('/doctracker', '')).toBe('/library');
    expect(legacyTarget('/library', '?view=security')).toBe('/library/security');
  });
  it('maps projects, tabs and endpoints', () => {
    expect(legacyTarget('/library/docs', '?p=P1')).toBe('/library/p/P1');
    expect(legacyTarget('/library/docs', '?p=P1&t=documents')).toBe('/library/p/P1');
    expect(legacyTarget('/library/docs', '?p=P1&t=apis')).toBe('/library/p/P1/api');
    expect(legacyTarget('/library/docs', '?p=P1&t=architecture')).toBe('/library/p/P1/architecture');
    expect(legacyTarget('/library/docs', '?p=general&ep=E9')).toBe('/library/p/general/api/E9');
    expect(legacyTarget('/doctracker/x', '?p=P1&new=1')).toBe('/library/p/P1?new=1');
  });
});

describe('topicOf', () => {
  it('reads the rest of a project address', () => {
    expect(topicOf('')).toEqual({ kind: 'overview' });
    expect(topicOf('api')).toEqual({ kind: 'api' });
    expect(topicOf('api/e1')).toEqual({ kind: 'endpoint', id: 'e1' });
    expect(topicOf('architecture')).toEqual({ kind: 'architecture' });
    expect(topicOf('d/doc1')).toEqual({ kind: 'guide', id: 'doc1' });
  });
});

describe('envLabels', () => {
  it('names servers', () => {
    expect(envLabels(['https://dev.x.in', 'https://uat.x.in', 'https://api.x.in']).map((e) => e.label)).toEqual(['DEV', 'UAT', 'PROD']);
    expect(envLabels(['https://a', 'https://b']).map((e) => e.label)).toEqual(['UAT', 'PROD']);
  });
});
