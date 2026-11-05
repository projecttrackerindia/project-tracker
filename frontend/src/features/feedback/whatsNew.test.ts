import { describe, expect, it } from 'vitest';
import md from './whats-new.md?raw';
import { parseChangelog, shouldShow } from './whatsNew';

describe("what's new", () => {
  it('parses releases and their changes', () => {
    const r = parseChangelog('<!-- note -->\n## 1.2 · Calm\n- **One** — First.\n- Plain line\n\n## 1.1\n- **Old** - Older.');
    expect(r.map((x) => x.version)).toEqual(['1.2', '1.1']);
    expect(r[0].name).toBe('Calm');
    expect(r[0].items[0]).toEqual({ title: 'One', text: 'First.' });
    expect(r[0].items[1]).toEqual({ title: '', text: 'Plain line' });
  });
  it('the shipped changelog parses', () => {
    expect(parseChangelog(md).length).toBeGreaterThan(0);
  });
  it('shows once per release and never on a first visit', () => {
    expect(shouldShow('2', null)).toBe('mark');
    expect(shouldShow('2', '1')).toBe('show');
    expect(shouldShow('2', '2')).toBe('none');
  });
});
