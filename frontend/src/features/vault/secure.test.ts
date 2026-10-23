import { describe, expect, it } from 'vitest';
import { generatePassphrase, generatePassword, parseCsv, randomBelow, readExport, strength } from './secure';

describe('strength (same rules as the server)', () => {
  it.each([
    ['password', 0], ['Password@123', 0], ['qwerty1234', 0], ['aaaaaaaaaaaa', 0], ['Summer@2024', 0], ['Sunshine', 0], ['password1', 0], ['Welcome@123', 0],
    ['Fivestar2024', 1], ['k8#Vq!2mZ@t9Lw$e', 4], ['orbit lantern mango river', 4], ['Tq7#vLm2!pZx9@Rk', 4], ['N3w!Passw0rd#Ax7q', 4],
  ])('%s scores %i', (p, s) => expect(strength(p)).toBe(s));
});

describe('generator', () => {
  it('has every chosen kind of character and the asked length', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword({ length: 20, upper: true, digits: true, symbols: true, avoidAmbiguous: true });
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[2-9]/); expect(p).toMatch(/[!@#$%^&*\-_=+?]/);
      expect(p).not.toMatch(/[lIO01]/);
      expect(strength(p)).toBeGreaterThanOrEqual(3);
    }
  });
  it('clamps the length', () => {
    expect(generatePassword({ length: 2, upper: false, digits: false, symbols: false, avoidAmbiguous: false })).toHaveLength(8);
    expect(generatePassword({ length: 999, upper: true, digits: true, symbols: false, avoidAmbiguous: false })).toHaveLength(128);
  });
  it('draws without modulo bias', () => {
    // A source that first returns a value in the biased tail must be asked again.
    const seq = [2 ** 32 - 1, 7];
    let n = 0;
    expect(randomBelow(10, (a) => { a[0] = seq[n++]; return a; })).toBe(7);
    expect(n).toBe(2);
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 6000; i++) counts[randomBelow(6)]++;
    counts.forEach((c) => expect(c).toBeGreaterThan(800));
  });
  it('makes passphrases of real words with a capital and a digit', () => {
    const p = generatePassphrase(5);
    expect(p.split('-')).toHaveLength(5);
    expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/\d/);
    expect(strength(p)).toBe(4);
  });
});

describe('reading another password manager’s export', () => {
  it('handles quotes, commas and new lines inside fields', () => {
    expect(parseCsv('a,"b, c","d ""q"""\r\n"line\none",2,3\n')).toEqual([['a', 'b, c', 'd "q"'], ['line\none', '2', '3']]);
  });
  it('maps Bitwarden columns', () => {
    const csv = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,GitHub,,,0,https://github.com,ravi,"p,ss""word",JBSWY3DPEHPK3PXP\n,,note,Empty,,,0,,,,\n';
    const r = readExport(csv);
    expect(r.source).toBe('Bitwarden');
    expect(r.rows).toEqual([{ title: 'GitHub', url: 'https://github.com', username: 'ravi', password: 'p,ss"word', totp: 'JBSWY3DPEHPK3PXP', notes: null }]);
  });
  it('maps Chrome columns and keeps spaces inside a password', () => {
    const r = readExport('name,url,username,password\nmail.example.in,https://mail.example.in,ravi, two words \n');
    expect(r.source).toBe('Chrome / Edge');
    expect(r.rows[0].password).toBe(' two words ');
  });
});
