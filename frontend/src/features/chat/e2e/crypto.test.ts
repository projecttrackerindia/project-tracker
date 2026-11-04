import { describe, expect, it } from 'vitest';
import { generateDevice, lockPrivateKey, makeBackup, newDeviceId, open, restoreBackup, seal, unb64, type DeviceIdentity } from './crypto';

async function device(userId: string): Promise<{ id: DeviceIdentity; pair: CryptoKeyPair; key: { userId: string; deviceId: string; publicKey: string } }> {
  const { pair, publicJwk } = await generateDevice();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const id: DeviceIdentity = { deviceId: newDeviceId(), privateKey: await lockPrivateKey(pkcs8), publicJwk };
  return { id, pair, key: { userId, deviceId: id.deviceId, publicKey: publicJwk } };
}

describe('private chat envelopes', () => {
  it('open on every recipient device and carry no plaintext', async () => {
    const asha = await device('u-asha'), bharat = await device('u-bharat');
    const env = await seal('{"t":"Sample launch note"}', asha.id, [asha.key, bharat.key], 'conv-1');
    expect(env).not.toContain('Sample launch note');
    expect(JSON.parse(env).keys).toHaveLength(2);
    const r = await open(env, bharat.id, 'conv-1');
    expect(r.ok && r.text).toBe('{"t":"Sample launch note"}');
    const mine = await open(env, asha.id, 'conv-1');
    expect(mine.ok).toBe(true);
  });

  it('do not open for another device, another conversation or after tampering', async () => {
    const asha = await device('u-asha'), bharat = await device('u-bharat'), chitra = await device('u-chitra');
    const env = await seal('hello', asha.id, [bharat.key], 'conv-1');
    expect(await open(env, chitra.id, 'conv-1')).toEqual({ ok: false, reason: 'not-for-this-device' });
    expect((await open(env, bharat.id, 'conv-2')).ok).toBe(false);
    const parsed = JSON.parse(env); parsed.ct = parsed.ct.slice(0, -2) + (parsed.ct.endsWith('AA') ? 'BB' : 'AA');
    expect((await open(JSON.stringify(parsed), bharat.id, 'conv-1')).ok).toBe(false);
    expect((await open('not json', bharat.id, 'conv-1')).ok).toBe(false);
  });

  it('keep the stored private key non-extractable', async () => {
    const a = await device('u-asha');
    expect(a.id.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', a.id.privateKey)).rejects.toBeTruthy();
  });

  it('restore from the recovery copy with the passphrase only', async () => {
    const a = await device('u-asha'), b = await device('u-bharat');
    const backup = await makeBackup(a.pair, a.id.publicJwk, 'a sample passphrase for tests', 1000);
    expect(unb64(backup.salt)).toHaveLength(16);
    await expect(restoreBackup(backup, 'the wrong passphrase')).rejects.toThrow(/passphrase/);
    const restored = await restoreBackup(backup, 'a sample passphrase for tests');
    const env = await seal('again', b.id, [a.key], 'conv-9');
    const r = await open(env, { ...a.id, privateKey: restored }, 'conv-9');
    expect(r.ok && r.text).toBe('again');
  });
});
