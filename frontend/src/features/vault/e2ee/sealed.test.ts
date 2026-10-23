import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SealedPayload } from './sealed';
import type { CollectionKeys, EnvelopeInput, SealedItemRow, VaultCollection, VaultIdentity, VaultKeysMe, VaultRecoveryToHelp, VaultUnlock } from '../api';

// This file runs without a DOM: a small stand-in for the browser's localStorage (pinned keys live there).
const store = new Map<string, string>();
(globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear'> }).localStorage ??= {
  getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
};

// ---- an in-memory server that behaves like the real one where it matters (who gets what), and never sees a secret
const T = 'tenant-1';
interface Env extends EnvelopeInput { collectionId: string; senderUserId: string }
const db = {
  identities: new Map<string, VaultIdentity>(), unlocks: new Map<string, VaultUnlock[]>(), envelopes: [] as Env[],
  items: [] as SealedItemRow[], versions: [] as { id: string; itemId: string; keyVersion: number; blob: string; at: string }[],
  access: new Map<string, Map<string, 'View' | 'Manage'>>(), keyVersion: new Map<string, number>(), rekeyNeeded: new Map<string, boolean>(),
  seen: [] as string[],
  circle: [] as { owner: string; trustee: string; threshold: number; generation: number; trusteeGeneration: number; envelope: string; signature: string }[],
  recoveries: new Map<string, { owner: string; x25519Public: string; mlKemPublic: string; releases: { trustee: string; envelope: string; signature: string }[] }>(),
};
let as = 'alice';
const record = (x: unknown) => { db.seen.push(JSON.stringify(x)); return x; };
vi.mock('../api', () => ({
  vaultApi: {
    setupKeys: async (b: { x25519Public: string; mlKemPublic: string; ed25519Public: string; selfSignature: string; fingerprint: string; unlocks: VaultUnlock[] }): Promise<VaultKeysMe> => {
      record(b);
      const identity = { userId: as, x25519Public: b.x25519Public, mlKemPublic: b.mlKemPublic, ed25519Public: b.ed25519Public, selfSignature: b.selfSignature, fingerprint: b.fingerprint, generation: 1 };
      db.identities.set(as, identity);
      db.unlocks.set(as, b.unlocks.map((u, i) => ({ ...u, id: `${as}-u${i}`, credentialId: u.credentialId ?? null, createdAt: '', lastUsedAt: null })));
      return { identity, unlocks: db.unlocks.get(as)! };
    },
    unlocked: async () => undefined,
    directory: async (ids: string[]) => ids.map((u) => ({ userId: u, name: u, access: 'None', identity: db.identities.get(u) ?? null })),
    collectionKeys: async (c: string): Promise<CollectionKeys> => {
      const acc = db.access.get(c)!, my = acc.get(as);
      if (!my) throw new Error('404');
      // Like the server: whoever lost access loses their envelopes, and the collection needs a new key.
      const gone = db.envelopes.filter((e) => e.collectionId === c && !acc.has(e.recipientUserId));
      if (gone.length) { db.envelopes = db.envelopes.filter((e) => !gone.includes(e)); db.rekeyNeeded.set(c, true); }
      const v = db.keyVersion.get(c)!;
      const have = db.envelopes.filter((e) => e.collectionId === c && e.keyVersion === v).map((e) => e.recipientUserId);
      return {
        collectionId: c, sealed: true, keyVersion: v, rekeyNeeded: !!db.rekeyNeeded.get(c), myAccess: my,
        mine: db.envelopes.filter((e) => e.collectionId === c && e.recipientUserId === as).map((e) => ({ ...e, senderEd25519Public: db.identities.get(e.senderUserId)?.ed25519Public ?? null })),
        pending: my === 'Manage' ? [...acc.keys()].filter((u) => !have.includes(u)).map((u) => ({ userId: u, name: u, access: acc.get(u)!, identity: db.identities.get(u) ?? null })) : null,
      };
    },
    saveEnvelopes: async (c: string, envs: EnvelopeInput[]) => { record(envs); for (const e of envs) db.envelopes.push({ ...e, collectionId: c, senderUserId: as }); return null as unknown as CollectionKeys; },
    sealedItems: async (c: string, bin = false) => { if (!db.access.get(c)!.has(as)) throw new Error('404'); return db.items.filter((i) => i.collectionId === c && !!i.deletedAt === bin); },
    createSealed: async (b: { id: string; collectionId: string; kind: string; keyVersion: number; blob: string }) => {
      record(b);
      const row = { id: b.id, collectionId: b.collectionId, kind: b.kind, keyVersion: b.keyVersion, blob: b.blob, expiresAt: null, rotateEveryDays: null, rotationReason: null, createdAt: '', updatedAt: null, valueChangedAt: null, deletedAt: null, myAccess: 'Manage', files: [], versions: 0 } as SealedItemRow;
      db.items.push(row); return row;
    },
    updateSealed: async (id: string, b: { keyVersion: number; blob: string; valueChanged: boolean }) => {
      record(b);
      const row = db.items.find((i) => i.id === id)!;
      if (b.valueChanged) { db.versions.push({ id: `v${db.versions.length}`, itemId: id, keyVersion: row.keyVersion, blob: row.blob, at: '' }); row.versions++; }
      row.blob = b.blob; row.keyVersion = b.keyVersion; return row;
    },
    sealedVersions: async (id: string) => db.versions.filter((v) => v.itemId === id).map((v) => ({ ...v, by: null, reason: null })),
    setCircle: async (b: { threshold: number; shares: { trusteeUserId: string; trusteeGeneration: number; envelope: string; signature: string }[] }) => {
      record(b);
      db.circle = db.circle.filter((c) => c.owner !== as).concat(b.shares.map((x) => ({ owner: as, trustee: x.trusteeUserId, threshold: b.threshold, generation: 1, trusteeGeneration: x.trusteeGeneration, envelope: x.envelope, signature: x.signature })));
      return null;
    },
    startRecovery: async (b: { label: string; x25519Public: string; mlKemPublic: string }) => {
      record(b);
      const id = `rec${db.recoveries.size + 1}`;
      db.recoveries.set(id, { owner: as, x25519Public: b.x25519Public, mlKemPublic: b.mlKemPublic, releases: [] });
      return status(id);
    },
    recoveryStatus: async (id: string) => status(id),
    finishRecovery: async () => undefined,
    helpRecovery: async (id: string, envelope: string, signature: string) => { record({ envelope, signature }); db.recoveries.get(id)!.releases.push({ trustee: as, envelope, signature }); },
    rekey: async (c: string, b: { newVersion: number; envelopes: EnvelopeInput[]; items: { id: string; blob: string }[]; versions: { id: string; blob: string }[] }) => {
      record(b);
      for (const i of b.items) Object.assign(db.items.find((x) => x.id === i.id)!, { blob: i.blob, keyVersion: b.newVersion });
      for (const v of b.versions) Object.assign(db.versions.find((x) => x.id === v.id)!, { blob: v.blob, keyVersion: b.newVersion });
      db.envelopes = db.envelopes.filter((e) => e.collectionId !== c);
      for (const e of b.envelopes) db.envelopes.push({ ...e, collectionId: c, senderUserId: as });
      db.keyVersion.set(c, b.newVersion); db.rekeyNeeded.set(c, false);
      return null as unknown as CollectionKeys;
    },
  },
}));

function status(id: string) {
  const r = db.recoveries.get(id)!;
  const mine = db.circle.filter((c) => c.owner === r.owner);
  return { id, threshold: mine[0]?.threshold ?? 0, helpers: mine.length, createdAt: '', expiresAt: new Date(Date.now() + 3600e3).toISOString(), completed: false, cancelled: false,
    releases: r.releases.map((x) => ({ trustee: { id: x.trustee, name: x.trustee }, trusteeEd25519Public: db.identities.get(x.trustee)!.ed25519Public, envelope: x.envelope, signature: x.signature, refused: false, at: '' })) };
}
const { keyring } = await import('./keyring');
const sealed = await import('./sealed');
const { deriveIdentity } = await import('./crypto');
const coll = (id: string): VaultCollection => ({ id, name: 'Prod keys', description: null, kind: 'Shared', projectId: null, projectName: null, teamId: null, teamName: null, myAccess: 'Manage', items: 0, atRisk: 0, requireStepUp: false, rotateEveryDays: null, locked: false, shares: null, sealed: true, rekeyNeeded: false, keyVersion: 1, requireApproval: false, requestable: false });
const seeds = new Map<string, Uint8Array>();
const become = (u: string) => { keyring.lock(); as = u; keyring.unlock(T, u, deriveIdentity(new Uint8Array(seeds.get(u)!)), 1, 'test'); };
const setUp = async (u: string) => {
  keyring.lock(); as = u;
  const r = await sealed.setUpKeys(T, { id: u, email: `${u}@x.test`, name: u }, { passkey: false });
  seeds.set(u, new Uint8Array(keyring.get().identity!.seed));
  return r;
};
const payload = (title: string, password: string): SealedPayload => ({ v: 1, title, url: null, tags: [], class: 'Secret', links: [], fields: [{ key: 'password', label: 'Password', type: 'password', secret: true, value: password }] });

describe('the sealed vault in the browser', () => {
  beforeEach(() => localStorage.clear());

  it('shares, reads, refuses tampering, and locks out whoever loses access', async () => {
    const a = await setUp('alice');
    expect(a.recoveryKey).toMatch(/^PTV1-/);
    await setUp('bob');
    const c = coll('c1');
    db.access.set('c1', new Map([['alice', 'Manage'], ['bob', 'View']])); db.keyVersion.set('c1', 1);

    become('alice');
    await sealed.firstKey('c1');
    await sealed.saveSealed(c, null, 'Login', payload('AWS root', 'Sup3r!Secret#2026'), { expiresAt: null, rotateEveryDays: null, valueChanged: false, reason: null });
    const opened = await sealed.openCollection(c);   // also hands the key to Bob, who has access and keys
    expect(opened.state).toBe('open');
    expect(db.envelopes.filter((e) => e.recipientUserId === 'bob')).toHaveLength(1);

    // The server never saw the secret, the title or a key.
    const seen = db.seen.join('\n');
    expect(seen).not.toContain('Sup3r!Secret#2026'); expect(seen).not.toContain('AWS root');
    expect(seen).not.toContain(Buffer.from(seeds.get('alice')!).toString('base64'));

    become('bob');
    const asBob = await sealed.openCollection({ ...c, myAccess: 'View' });
    expect(asBob.state).toBe('open');
    const list = await sealed.listSealed(c);
    expect(list[0].payload?.fields[0].value).toBe('Sup3r!Secret#2026');

    // A swapped envelope (signed by someone else) is not used.
    keyring.lock(); as = 'bob'; keyring.unlock(T, 'bob', deriveIdentity(new Uint8Array(seeds.get('bob')!)), 1, 'test');
    const bobEnv = db.envelopes.find((e) => e.recipientUserId === 'bob')!;
    const original = bobEnv.signature;
    bobEnv.signature = db.envelopes.find((e) => e.recipientUserId === 'alice')!.signature;
    const tampered = await sealed.openCollection({ ...c, myAccess: 'View' });
    expect(tampered.state).not.toBe('open'); expect(tampered.warning).toMatch(/not signed/);
    bobEnv.signature = original;

    // Bob loses access: his envelope goes; Alice's next open makes a new key and re-encrypts everything, history included.
    become('alice');
    await sealed.openCollection(c);
    const item = (await sealed.listSealed(c))[0].row;
    await sealed.saveSealed(c, item, 'Login', payload('AWS root', 'N3w!Value#After'), { expiresAt: null, rotateEveryDays: null, valueChanged: true, reason: 'rotated' });
    db.access.get('c1')!.delete('bob');
    await sealed.openCollection(c);
    expect(db.keyVersion.get('c1')).toBe(2);
    expect(db.items.every((i) => i.keyVersion === 2)).toBe(true);
    expect(db.versions.every((v) => v.keyVersion === 2)).toBe(true);
    expect((await sealed.listSealed(c))[0].payload?.fields[0].value).toBe('N3w!Value#After');
    const history = await sealed.sealedHistory(c, item.id);
    expect(history[0].payload?.fields[0].value).toBe('Sup3r!Secret#2026');
    expect(db.envelopes.some((e) => e.recipientUserId === 'bob')).toBe(false);
  });

  it('gives the keys back through the recovery circle only from enough colleagues, never showing the server a share or the secret', async () => {
    for (const u of ['erin', 'finn', 'gwen']) await setUp(u);
    const hana = await setUp('hana');
    const secret = Buffer.from(seeds.get('hana')!).toString('base64');
    become('hana');
    await sealed.setUpCircle(['erin', 'finn', 'gwen'].map((u) => ({ userId: u, name: u, identity: db.identities.get(u)! })), 2, undefined);
    expect(db.circle.filter((c) => c.owner === 'hana')).toHaveLength(3);

    // A new browser with nothing: ask the circle. The code is what each helper compares with Hana.
    keyring.lock(); as = 'hana';
    const started = await sealed.startRecovery('New laptop');
    expect(started.code).toMatch(/^\d{4} \d{4}$/);
    const toHelp = (u: string): VaultRecoveryToHelp => {
      const share = db.circle.find((c) => c.owner === 'hana' && c.trustee === u)!, r = db.recoveries.get(started.status.id)!;
      return { requestId: started.status.id, person: { id: 'hana', name: 'hana' }, x25519Public: r.x25519Public, mlKemPublic: r.mlKemPublic, createdAt: '', expiresAt: '', ipAddress: null, userAgent: null,
        shareEnvelope: share.envelope, shareSignature: share.signature, ownerEd25519Public: db.identities.get('hana')!.ed25519Public, ownerGeneration: 1, threshold: share.threshold };
    };
    // A share is only opened by its colleague, and only if Hana signed it.
    become('finn');
    await expect(sealed.helpRecovery({ ...toHelp('erin') })).rejects.toThrow();
    await expect(sealed.helpRecovery({ ...toHelp('finn'), shareSignature: toHelp('gwen').shareSignature })).rejects.toThrow(/not signed/);
    for (const u of ['erin', 'gwen']) { become(u); await sealed.helpRecovery(toHelp(u)); }

    keyring.lock(); as = 'hana';
    const progress: number[] = [];
    await sealed.waitForRecovery(T, 'hana', hana.keys, started, new AbortController().signal, (got) => progress.push(got));
    expect(keyring.isOpenFor(T, 'hana')).toBe(true);
    expect(Buffer.from(keyring.get().identity!.seed).toString('base64')).toBe(secret);
    expect(progress.at(-1)).toBe(2);
    expect(db.seen.join('\n')).not.toContain(secret);
  });

  it('unlocks only with the right recovery key and only for the keys on record', async () => {
    const { recoveryKey, keys } = await setUp('carol');
    keyring.lock();
    await expect(sealed.unlockWithRecoveryKey(T, 'carol', keys, 'PTV1-AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH')).rejects.toThrow(/does not open/);
    await sealed.unlockWithRecoveryKey(T, 'carol', keys, recoveryKey.toLowerCase());
    expect(keyring.isOpenFor(T, 'carol')).toBe(true);
    // A server that swaps the public keys on record cannot get a secret accepted for them.
    keyring.lock();
    const other = (await setUp('dave')).keys.identity!;
    keyring.lock();
    await expect(sealed.unlockWithRecoveryKey(T, 'carol', { ...keys, identity: { ...other, userId: 'carol' } }, recoveryKey)).rejects.toThrow(/do not match/);
    expect(keyring.isOpenFor(T, 'carol')).toBe(false);
  });
});
