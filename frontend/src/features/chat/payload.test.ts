import { describe, expect, it } from 'vitest';
import { cleanFileName, detectPayload, diffJson, findSecrets, kindOf, kindOfFile, maskSecrets, parseCsv, parseLog, payloadFileName, slug } from './payload';

const bigJson = JSON.stringify({ customer: { id: 42, name: 'Asha' }, items: Array.from({ length: 40 }, (_, i) => ({ i, sku: `SKU-${i}`, qty: i % 3 })) });
const logText = Array.from({ length: 30 }, (_, i) => `2026-10-27 18:${String(i).padStart(2, '0')}:01.120 ${i % 7 === 0 ? 'ERROR' : 'INFO'} [main] c.f.Crif - step ${i}`).join('\n');

describe('detectPayload', () => {
  it('leaves ordinary messages and short snippets alone', () => {
    expect(detectPayload('Can you check the CRIF call?')).toBeNull();
    expect(detectPayload('{"ok":true,"id":7}')).toBeNull();
    expect(detectPayload('2026-10-27 10:00:00 INFO a\n2026-10-27 10:00:01 INFO b\n2026-10-27 10:00:02 WARN c')).toBeNull();
  });
  it('finds JSON and pretty-prints it, counting the readable lines', () => {
    const p = detectPayload(bigJson)!;
    expect(p.kind).toBe('json');
    expect(p.text.startsWith('{\n  "customer"')).toBe(true);
    expect(p.lines).toBeGreaterThan(100);
    expect(p.bytes).toBe(new TextEncoder().encode(p.text).length);
  });
  it('finds logs, XML and CSV', () => {
    expect(detectPayload(logText)!.kind).toBe('log');
    const xml = `<?xml version="1.0"?>\n<root>\n${Array.from({ length: 30 }, (_, i) => `  <item id="${i}">v${i}</item>`).join('\n')}\n</root>`;
    expect(detectPayload(xml)!.kind).toBe('xml');
    const csv = ['id,name,amount', ...Array.from({ length: 30 }, (_, i) => `${i},Name ${i},${i * 10}`)].join('\n');
    expect(detectPayload(csv)!.kind).toBe('csv');
  });
  it('treats stack traces as logs', () => {
    expect(kindOf('java.lang.NullPointerException: boom\n    at a.b.C.d(C.java:10)\n    at a.b.C.e(C.java:20)\n    at a.b.Main.main(Main.java:5)')).toBe('log');
  });
  it('offers any very long text (over 4,000 characters or 60 lines) as a file', () => {
    expect(detectPayload('word '.repeat(900))!.kind).toBe('text');
    expect(detectPayload(Array.from({ length: 61 }, (_, i) => `line ${i}`).join('\n'))).not.toBeNull();
    expect(detectPayload(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'))).toBeNull();
  });
});

describe('file names', () => {
  const at = new Date(2026, 9, 27, 18, 42);
  it('names the file after the kind, the conversation and the time', () => {
    expect(payloadFileName('json', 'CRIF', at)).toBe('payload-CRIF-2026-10-27-1842.json');
    expect(payloadFileName('log', '#mule-prod alerts', at)).toBe('log-mule-prod-alerts-2026-10-27-1842.log');
    expect(payloadFileName('csv', '', at)).toBe('data-2026-10-27-1842.csv');
    expect(payloadFileName('text', null, at)).toBe('text-2026-10-27-1842.txt');
  });
  it('makes names safe and keeps the extension', () => {
    expect(slug('Café / Ops: Q4')).toBe('Cafe-Ops-Q4');
    expect(cleanFileName('crif response', 'json')).toBe('crif response.json');
    expect(cleanFileName('a/b:c.log', 'log')).toBe('a-b-c.log');
    expect(cleanFileName('  ', 'xml')).toMatch(/^payload-\d{4}-\d{2}-\d{2}-\d{4}\.xml$/);
  });
  it('knows the kind of a sent file', () => {
    expect(kindOfFile('payload.json')).toBe('json');
    expect(kindOfFile('server.LOG')).toBe('log');
    expect(kindOfFile('report.pdf', 'application/pdf')).toBeNull();
    expect(kindOfFile('blob', 'application/json')).toBe('json');
  });
});

describe('secrets', () => {
  it('finds and masks Authorization headers, password and token fields, JWTs and keys', () => {
    const t = [
      'Authorization: Bearer abc.def-123456',
      '{"username":"asha","password":"S3cret!pass","access_token":"tok_998877","note":null}',
      '<client_secret>zzz-secret-value</client_secret>',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
      'key AKIAABCDEFGHIJKLMNOP',
    ].join('\n');
    const found = findSecrets(t);
    expect(found).toEqual(expect.arrayContaining(['Authorization header', 'password or token field', 'JWT', 'AWS access key']));
    const m = maskSecrets(t);
    for (const s of ['abc.def-123456', 'S3cret!pass', 'tok_998877', 'zzz-secret-value', 'eyJhbGciOiJIUzI1NiJ9', 'AKIAABCDEFGHIJKLMNOP']) expect(m).not.toContain(s);
    expect(m).toContain('"password":"••••••••"');
    expect(m).toContain('Authorization: Bearer ••••••••');
    expect(m).toContain('<client_secret>••••••••</client_secret>');
    expect(m).toContain('"username":"asha"');
    expect(m).toContain('"note":null');
  });
  it('finds nothing in an ordinary payload', () => {
    expect(findSecrets(bigJson)).toEqual([]);
    expect(maskSecrets(bigJson)).toBe(bigJson);
  });
});

describe('logs, diff and CSV', () => {
  it('gives each line a level, stack frames following their error', () => {
    const l = parseLog('2026-10-27 10:00:00 INFO start\n2026-10-27 10:00:01 ERROR failed\n    at a.b(C.java:1)\n2026-10-27 10:00:02 WARN slow');
    expect(l.map((x) => x.level)).toEqual(['info', 'error', 'error', 'warn']);
  });
  it('lists what changed between two JSON documents by path', () => {
    const d = diffJson({ a: 1, b: { c: [1, 2] }, 'x-y': true }, { a: 2, b: { c: [1] }, n: 'new', 'x-y': true });
    expect(d).toEqual([
      { path: '$.a', kind: 'changed', before: 1, after: 2 },
      { path: '$.b.c[1]', kind: 'removed', before: 2 },
      { path: '$.n', kind: 'added', after: 'new' },
    ]);
  });
  it('reads quoted CSV', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
  });
});
