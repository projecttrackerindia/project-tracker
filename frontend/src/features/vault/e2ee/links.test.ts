import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LinkKeyError, openLink, sealLink, tokenHash, type LinkPayload } from './links';

const payload: LinkPayload = { v: 1, title: 'Wi-Fi at the office', fields: [{ label: 'Network', value: 'FIVESTAR-5G', secret: false }, { label: 'Password', value: 'Mang0!Lassi#42', secret: true }] };
const parts = (url: string) => { const u = new URL(url); return { token: u.pathname.split('/').pop()!, fragment: u.hash.slice(1) }; };

describe('self-destructing links', () => {
  it('keeps the key in the fragment and gives the server only ciphertext and the token hash', async () => {
    const made = await sealLink(payload, null, 'https://pt.example');
    const { token, fragment } = parts(made.url);
    expect(made.url).toMatch(/^https:\/\/pt\.example\/s\/[A-Za-z0-9_-]{43}#[A-Za-z0-9_-]{43}$/);
    expect(made.body.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(tokenHash(token)).toBe(made.body.tokenHash);
    const sent = JSON.stringify(made.body);
    for (const s of ['Mang0!Lassi#42', 'FIVESTAR-5G', 'Wi-Fi', fragment, token]) expect(sent).not.toContain(s);
    expect(await openLink(token, fragment, made.body.cipher, null, null, null)).toEqual(payload);
  });

  it('needs the passphrase when there is one, and binds the secret to its own link', async () => {
    const made = await sealLink(payload, 'blue elephant', 'https://pt.example');
    const { token, fragment } = parts(made.url);
    expect(made.body.hasPassphrase).toBe(true);
    await expect(openLink(token, fragment, made.body.cipher, 'blue elefant', made.body.salt, made.body.params)).rejects.toBeInstanceOf(LinkKeyError);
    await expect(openLink(token, fragment, made.body.cipher, null, null, null)).rejects.toBeInstanceOf(LinkKeyError);
    expect(await openLink(token, fragment, made.body.cipher, 'blue elephant', made.body.salt, made.body.params)).toEqual(payload);
    // The same ciphertext under another link's token does not open (a server cannot swap secrets between links).
    const other = parts((await sealLink(payload, null, 'https://pt.example')).url);
    await expect(openLink(other.token, fragment, made.body.cipher, 'blue elephant', made.body.salt, made.body.params)).rejects.toBeInstanceOf(LinkKeyError);
    await expect(openLink(token, fragment.slice(0, 20), made.body.cipher, 'blue elephant', made.body.salt, made.body.params)).rejects.toThrow(/incomplete/);
  });
});
