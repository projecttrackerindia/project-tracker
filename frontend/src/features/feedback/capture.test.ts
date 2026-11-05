import { describe, expect, it } from 'vitest';
import { _rings, recentConsole } from './capture';

describe('problem capture', () => {
  it('keeps a short ring of the latest lines', () => {
    for (let i = 0; i < 40; i++) _rings.push(_rings.consoleTail, `line ${i}`);
    const tail = recentConsole();
    expect(tail).toHaveLength(30);
    expect(tail[tail.length - 1]).toBe('line 39');
  });
});
