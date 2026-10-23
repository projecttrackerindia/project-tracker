import { describe, expect, it } from 'vitest';
import {
  aesOpen, aesSeal, b64, breachCount, breachParts, ckContext, deriveIdentity, ephemeralKeys, linkCode, matches, newRecoveryKey, openFrom, parseRecoveryKey,
  prfKek, publicBundle, random, recoveryKek, safetyCode, sealTo, totpNow, unb64, utf8, verifyBundle, verifyEnvelope, fromUtf8, VaultCryptoError,
} from './crypto';

describe('identity', () => {
  it('is deterministic from the secret and only public halves leave', () => {
    const seed = random(32);
    const a = deriveIdentity(seed), b = deriveIdentity(new Uint8Array(seed));
    expect(b64(a.xPub)).toBe(b64(b.xPub)); expect(b64(a.kemPub)).toBe(b64(b.kemPub)); expect(b64(a.edPub)).toBe(b64(b.edPub));
    expect(a.kemPub.length).toBe(1184);
    const bundle = publicBundle(a);
    expect(bundle.fingerprint).toMatch(/^\d{5}( \d{5}){11}$/);
    expect(verifyBundle(bundle)).toBe(true);
    expect(matches(b, bundle)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain(b64(seed));
  });
  it('refuses a bundle whose keys or safety code were changed', () => {
    const bundle = publicBundle(deriveIdentity(random(32)));
    const other = publicBundle(deriveIdentity(random(32)));
    expect(verifyBundle({ ...bundle, x25519Public: other.x25519Public })).toBe(false);
    expect(verifyBundle({ ...bundle, fingerprint: other.fingerprint })).toBe(false);
    expect(verifyBundle({ ...bundle, mlKemPublic: other.mlKemPublic, selfSignature: other.selfSignature })).toBe(false);
  });
  it('gives different safety codes for different keys', () => {
    const a = deriveIdentity(random(32)), b = deriveIdentity(random(32));
    expect(safetyCode(a.xPub, a.kemPub, a.edPub)).not.toBe(safetyCode(b.xPub, b.kemPub, b.edPub));
  });
});

describe('hybrid envelopes', () => {
  const ctx = ckContext('t1', 'c1', 1, 'u2', 1);
  it('open only for the recipient, only in their context, and the signature names the sender', async () => {
    const alice = deriveIdentity(random(32)), bob = deriveIdentity(random(32)), eve = deriveIdentity(random(32));
    const ck = random(32);
    const env = await sealTo(publicBundle(bob), ck, ctx, alice);
    expect(Array.from(await openFrom(bob, env.envelope, ctx))).toEqual(Array.from(ck));
    expect(verifyEnvelope(b64(alice.edPub), env, ctx)).toBe(true);
    expect(verifyEnvelope(b64(eve.edPub), env, ctx)).toBe(false);
    await expect(openFrom(eve, env.envelope, ctx)).rejects.toBeInstanceOf(VaultCryptoError);
    await expect(openFrom(bob, env.envelope, ckContext('t1', 'c2', 1, 'u2', 1))).rejects.toBeInstanceOf(VaultCryptoError);
    expect(verifyEnvelope(b64(alice.edPub), env, ckContext('t1', 'c2', 1, 'u2', 1))).toBe(false);
    // Any changed byte is caught.
    const raw = unb64(env.envelope); raw[raw.length - 1] ^= 1;
    await expect(openFrom(bob, b64(raw), ctx)).rejects.toBeInstanceOf(VaultCryptoError);
  });
  it('needs both the classical and the post-quantum secret', async () => {
    const alice = deriveIdentity(random(32)), bob = deriveIdentity(random(32)), mallory = deriveIdentity(random(32));
    const env = await sealTo(publicBundle(bob), random(32), ctx, alice);
    await expect(openFrom({ xPriv: bob.xPriv, kemSec: mallory.kemSec }, env.envelope, ctx)).rejects.toBeInstanceOf(VaultCryptoError);
    await expect(openFrom({ xPriv: mallory.xPriv, kemSec: bob.kemSec }, env.envelope, ctx)).rejects.toBeInstanceOf(VaultCryptoError);
  });
  it('fits the server limits', async () => {
    const a = deriveIdentity(random(32));
    const env = await sealTo(publicBundle(a), random(32), ctx, a);
    expect(env.envelope.length).toBeGreaterThan(1500); expect(env.envelope.length).toBeLessThan(4000);
    expect(env.signature.length).toBeLessThan(120);
  });
});

describe('items', () => {
  it('are bound to their place', async () => {
    const ck = random(32);
    const ct = await aesSeal(ck, utf8('{"title":"AWS"}'), 'item|t|c|i1');
    expect(fromUtf8(await aesOpen(ck, ct, 'item|t|c|i1'))).toBe('{"title":"AWS"}');
    await expect(aesOpen(ck, ct, 'item|t|c|i2')).rejects.toBeInstanceOf(VaultCryptoError);
    await expect(aesOpen(random(32), ct, 'item|t|c|i1')).rejects.toBeInstanceOf(VaultCryptoError);
  });
});

describe('unlocking', () => {
  it('reads back a recovery key typed loosely and refuses a wrong one', () => {
    const k = newRecoveryKey();
    expect(k.text).toMatch(/^PTV1(-[A-Z2-9]{4}){8}$/);
    expect(Array.from(parseRecoveryKey(k.text.toLowerCase().replace(/-/g, ' '))!)).toEqual(Array.from(k.bytes));
    expect(parseRecoveryKey('PTV1-AAAA')).toBeNull();
    expect(parseRecoveryKey(k.text.replace(/.$/, 'O'))).toBeNull();
  });
  it('wraps the secret under Argon2id and a passkey PRF', async () => {
    const seed = random(32), salt = random(16);
    const k = newRecoveryKey();
    const kek = await recoveryKek(k.bytes, salt);
    const wrapped = await aesSeal(kek, seed, 'seed|t|u|RecoveryKey');
    expect(Array.from(await aesOpen(await recoveryKek(parseRecoveryKey(k.text)!, salt), wrapped, 'seed|t|u|RecoveryKey'))).toEqual(Array.from(seed));
    await expect(aesOpen(await recoveryKek(newRecoveryKey().bytes, salt), wrapped, 'seed|t|u|RecoveryKey')).rejects.toBeInstanceOf(VaultCryptoError);
    const prf = random(32), psalt = random(32);
    const w2 = await aesSeal(prfKek(prf, psalt), seed, 'seed|t|u|Passkey');
    expect(Array.from(await aesOpen(prfKek(prf, psalt), w2, 'seed|t|u|Passkey'))).toEqual(Array.from(seed));
  });
  it('shows the same link code on both devices', () => {
    const e = ephemeralKeys();
    expect(linkCode(e.x25519Public, e.mlKemPublic)).toMatch(/^\d{4} \d{4}$/);
    expect(linkCode(e.x25519Public, e.mlKemPublic)).toBe(linkCode(e.x25519Public, e.mlKemPublic));
  });
});

describe('one-time codes and breach checks', () => {
  it('match RFC 6238', () => {
    expect(totpNow('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8', 59_000)).toEqual({ code: '94287082', left: 1, period: 30 });
    expect(totpNow('otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA&digits=8&algorithm=SHA256', 59_000)!.code).toBe('46119246');
    expect(totpNow('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 1_800_000_000_000)!.code).toBe('768147');
    expect(totpNow('not a key')).toBeNull();
  });
  it('send only a five-character prefix', () => {
    const { prefix, suffix } = breachParts('password');
    expect(prefix).toBe('5BAA6'); expect(suffix).toHaveLength(35);
    expect(breachCount(`0000000000000000000000000000000000A:0\r\n${suffix}:9659365\r\n`, suffix)).toBe(9659365);
  });
});
