import { describe, expect, it } from 'vitest';
import { safeRedirect } from './redirect';

describe('authentication return paths', () => {
  it('preserves an invitation and its token across sign-in', () => {
    expect(safeRedirect('/invite?token=one%2Btwo')).toBe('/invite?token=one%2Btwo');
  });
  it.each([null, '', 'https://external.example', '//external.example', '/\\external.example', '/\n/external.example', '/\r/external.example', 'relative/path', '/' + 'a'.repeat(2048)])('refuses unsafe return path %j', (path) => {
    expect(safeRedirect(path)).toBe('/');
  });
});
