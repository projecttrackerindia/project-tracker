import { describe, expect, it } from 'vitest';
import { conciseTitle, needsShortTitle, TITLE_MAX } from './conciseTitle';

const PARA = 'Hi Team, We will carry out planned security remediation on the network firewall cluster this weekend. Expect short outages between 2 and 4 AM. Please plan accordingly and reach out to INFRA with any concerns about critical services.';

describe('conciseTitle', () => {
  it('drops the greeting and keeps the first sentence', () => {
    expect(conciseTitle(PARA)).toBe('We will carry out planned security remediation on the network firewall cluster this weekend');
  });
  it('never returns more than the limit', () => {
    const t = conciseTitle('word '.repeat(80));
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
  });
  it('knows a paragraph from a title', () => {
    expect(needsShortTitle(PARA)).toBe(true);
    expect(needsShortTitle('Fix login timeout for Lena tomorrow')).toBe(false);
  });
});
