import { describe, expect, it } from 'vitest';
import { isCodeOnly, looksLikeCode, splitBody } from './codeDetect';

describe('splitBody', () => {
  it('keeps ordinary messages as text', () => {
    expect(splitBody('okay, thanks')).toEqual([{ kind: 'text', text: 'okay, thanks', long: false }]);
    expect(isCodeOnly('Sure, will send the receipt deed doc.')).toBe(false);
    expect(isCodeOnly('https://example.com/' + 'a'.repeat(300))).toBe(false);
  });
  it('treats a JSON payload as one code block, pretty-printing a one-liner', () => {
    const one = JSON.stringify({ serviceCode: 'CAS10001', monitoringDate: '08102020', addresses: [{ line1: 'x', pinCode: '600054' }] });
    const [s] = splitBody(one);
    expect(s).toMatchObject({ kind: 'code', lang: 'json' });
    expect(s.text.split('\n').length).toBeGreaterThan(5);
    expect(isCodeOnly('{\n  "a": 1\n}')).toBe(true);
  });
  it('splits fenced code out of prose', () => {
    expect(splitBody('look:\n```js\nconst a = 1;\n```\nthanks')).toEqual([
      { kind: 'text', text: 'look:' }, { kind: 'code', text: 'const a = 1;', lang: 'js' }, { kind: 'text', text: 'thanks' }]);
  });
  it('spots pasted code and long tokens', () => {
    expect(looksLikeCode('function f(a) {\n  if (a) {\n    return 1;\n  }\n}')).toBe(true);
    expect(looksLikeCode('Hi team,\nthe server is back.\nPlease retry.\nThanks')).toBe(false);
    expect(isCodeOnly('eyJ' + 'A'.repeat(400))).toBe(true);
  });
  it('folds very long prose', () => {
    expect(splitBody('word '.repeat(400))[0]).toMatchObject({ kind: 'text', long: true });
  });
});
