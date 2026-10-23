import { saveFile } from '../../../lib/native';
import { vaultApi, type CollectionKeys, type EnvelopeInput, type SealedFile, type SealedItemRow, type VaultClass, type VaultCollection, type VaultField, type VaultIdentity, type VaultItemKind, type VaultKeysMe, type VaultLink, type VaultRecoveryToHelp, type UnlockInput } from '../api';
import {
  aesOpen, aesSeal, b64, breachCount, breachParts, circleContext, ckContext, concat, releaseContext, deriveIdentity, deviceContext, ephemeralKeys, fromUtf8, itemContext, linkCode, matches, newRecoveryKey,
  forget, openFrom, parseRecoveryKey, prfKek, publicBundle, random, RECOVERY_PARAMS, recoveryKek, sealTo, seedContext, unb64, utf8, VaultCryptoError, verifyBundle, verifyEnvelope, wipe, type Identity,
} from './crypto';
import { keyring, pins } from './keyring';
import { createVaultPasskey, evaluate } from './passkey';
import { combine, split } from './shamir';

/** What a sealed item holds, encrypted as one document. Nothing in it is ever seen by the server. */
export interface SealedPayload {
  v: 1; title: string; url: string | null; tags: string[]; class: VaultClass; fields: VaultField[]; links: VaultLink[];
}
export interface SealedItem { row: SealedItemRow; payload: SealedPayload | null; error: string | null }

const me = () => {
  const s = keyring.get();
  if (!s.identity || !s.tenant || !s.user) throw new SealedError('Unlock your sealed vault first.');
  return { id: s.identity, tenant: s.tenant, user: s.user, generation: s.generation };
};
export class SealedError extends Error {}
const asBundle = (i: VaultIdentity) => ({ x25519Public: i.x25519Public, mlKemPublic: i.mlKemPublic, ed25519Public: i.ed25519Public, selfSignature: i.selfSignature, fingerprint: i.fingerprint });

// ------------------------------------------------------------------ setting up and unlocking

/**
 * Makes the identity secret here, wraps it under a new recovery key (and a passkey, when the device can), and saves only the public keys
 * and the wrapped copies. Returns the recovery key's text for the person to keep; it is shown once.
 */
export async function setUpKeys(tenant: string, user: { id: string; email: string; name: string }, opts: { passkey: boolean; reset?: boolean; stepUp?: string }) {
  const seed = random(32);
  const identity = deriveIdentity(seed);
  const rk = newRecoveryKey();
  const salt = random(16);
  const kek = await recoveryKek(rk.bytes, salt);
  const unlocks: UnlockInput[] = [{ kind: 'RecoveryKey', label: 'Recovery key', salt: b64(salt), params: RECOVERY_PARAMS, wrappedSeed: b64(await aesSeal(kek, seed, seedContext(tenant, user.id, 'RecoveryKey'))) }];
  wipe(kek, rk.bytes);
  let passkeyNote: string | null = null;
  if (opts.passkey) {
    try { unlocks.push(await passkeyUnlock(tenant, user, seed, 'This device')); }
    catch (e) { passkeyNote = e instanceof Error ? e.message : 'The passkey was not made.'; }
  }
  const res = await vaultApi.setupKeys({ ...publicBundle(identity), unlocks, reset: opts.reset, stepUp: opts.stepUp });
  keyring.unlock(tenant, user.id, identity, res.identity!.generation, unlocks.length > 1 ? 'passkey' : 'recovery key');
  return { recoveryKey: rk.text, passkeyNote, keys: res };
}

async function passkeyUnlock(tenant: string, user: { id: string; email: string; name: string }, seed: Uint8Array, label: string) {
  const salt = random(32);
  const { credentialId, prf } = await createVaultPasskey(user, salt, label);
  const kek = prfKek(prf, salt);
  try { return { kind: 'Passkey' as const, label, credentialId, salt: b64(salt), params: 'webauthn-prf;hkdf-sha256', wrappedSeed: b64(await aesSeal(kek, seed, seedContext(tenant, user.id, 'Passkey'))) }; }
  finally { wipe(prf, kek); }
}

/** Adds a passkey on this device (the vault must be unlocked: the secret is wrapped again under the new passkey). */
export async function addPasskey(user: { id: string; email: string; name: string }, label: string) {
  const { id, tenant } = me();
  return vaultApi.addUnlock(await passkeyUnlock(tenant, user, id.seed, label));
}

/** A new recovery key (the old ones keep working until removed). */
export async function addRecoveryKey() {
  const { id, tenant, user } = me();
  const rk = newRecoveryKey(), salt = random(16);
  const kek = await recoveryKek(rk.bytes, salt);
  const res = await vaultApi.addUnlock({ kind: 'RecoveryKey', label: `Recovery key (${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})`, salt: b64(salt), params: RECOVERY_PARAMS,
    wrappedSeed: b64(await aesSeal(kek, id.seed, seedContext(tenant, user, 'RecoveryKey'))) });
  wipe(kek, rk.bytes);
  return { recoveryKey: rk.text, keys: res };
}

function accept(tenant: string, user: string, keys: VaultKeysMe, seed: Uint8Array, unlockId: string, via: string) {
  if (!keys.identity) throw new SealedError('Your vault keys are not set up.');
  const identity = deriveIdentity(seed);
  // The secret must give exactly the public keys on record; otherwise either the secret or the server's record is wrong. Refuse both.
  if (!matches(identity, asBundle(keys.identity)) || !verifyBundle(asBundle(keys.identity))) { wipe(seed); throw new SealedError('These keys do not match the ones on record. Nothing was opened.'); }
  keyring.unlock(tenant, user, identity, keys.identity.generation, via);
  if (unlockId) void vaultApi.unlocked(unlockId).catch(() => undefined);
}

export async function unlockWithPasskey(tenant: string, user: string, keys: VaultKeysMe) {
  const options = keys.unlocks.filter((u) => u.kind === 'Passkey' && u.credentialId).map((u) => ({ credentialId: u.credentialId!, salt: unb64(u.salt), u }));
  if (options.length === 0) throw new SealedError('No passkey unlocks this vault yet. Use the recovery key, then add a passkey.');
  const { credentialId, prf } = await evaluate(options);
  const hit = options.find((o) => o.credentialId === credentialId) ?? options.find((o) => o.credentialId.replace(/=+$/, '') === credentialId);
  if (!hit) throw new SealedError('That passkey is not one of your vault keys.');
  const kek = prfKek(prf, hit.salt);
  try { accept(tenant, user, keys, await aesOpen(kek, unb64(hit.u.wrappedSeed), seedContext(tenant, user, 'Passkey')), hit.u.id, 'passkey'); }
  finally { wipe(prf, kek); }
}

export async function unlockWithRecoveryKey(tenant: string, user: string, keys: VaultKeysMe, text: string) {
  const bytes = parseRecoveryKey(text);
  if (!bytes) throw new SealedError('That is not a recovery key. It looks like PTV1-XXXX-XXXX-… (32 letters and digits).');
  try {
    for (const u of keys.unlocks.filter((x) => x.kind === 'RecoveryKey')) {
      const kek = await recoveryKek(bytes, unb64(u.salt), u.params);
      try { accept(tenant, user, keys, await aesOpen(kek, unb64(u.wrappedSeed), seedContext(tenant, user, 'RecoveryKey')), u.id, 'recovery key'); return; }
      catch (e) { if (!(e instanceof VaultCryptoError)) throw e; }
      finally { wipe(kek); }
    }
  } finally { wipe(bytes); }
  throw new SealedError('That recovery key does not open this vault.');
}

// ------------------------------------------------------------------ linking a device

/** On the new device: one-time keys, a request, and the code to compare. Call `waitForLink` to finish. */
export async function startLink(label: string) {
  const eph = ephemeralKeys();
  const link = await vaultApi.requestDevice({ label, x25519Public: eph.x25519Public, mlKemPublic: eph.mlKemPublic });
  return { link, eph, code: linkCode(eph.x25519Public, eph.mlKemPublic) };
}

export async function waitForLink(tenant: string, user: string, keys: VaultKeysMe, started: Awaited<ReturnType<typeof startLink>>, signal: AbortSignal) {
  try {
    while (!signal.aborted) {
      const s = await vaultApi.deviceStatus(started.link.id);
      if (s.denied) throw new SealedError('The other device refused this request.');
      if (s.envelope && s.signature) {
        const ctx = deviceContext(tenant, user, s.id);
        if (!keys.identity || !verifyEnvelope(keys.identity.ed25519Public, { envelope: s.envelope, signature: s.signature }, ctx)) throw new SealedError('The answer was not signed by your vault keys. Nothing was opened.');
        const seed = await openFrom(started.eph, s.envelope, ctx);
        accept(tenant, user, keys, seed, '', 'linked device');
        return;
      }
      if (Date.parse(s.expiresAt) < Date.now()) throw new SealedError('The request ran out of time. Start again.');
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally { wipe(started.eph.xPriv, started.eph.kemSec); }
}

/** On an unlocked device, after the person saw the same code on both screens. */
export async function approveLink(link: { id: string; x25519Public: string; mlKemPublic: string }) {
  const { id, tenant, user } = me();
  const env = await sealTo(link, id.seed, deviceContext(tenant, user, link.id), id);
  await vaultApi.approveDevice(link.id, env.envelope, env.signature);
}

// ------------------------------------------------------------------ the recovery circle

/**
 * Splits this person's identity secret among colleagues (any `threshold` of them give it back) and encrypts each share to that colleague's
 * own keys, signed with this person's key. A colleague whose key changed since this device last saw it is refused until the safety codes
 * are compared: otherwise a server could slip in its own key and collect a share.
 */
export async function setUpCircle(people: { userId: string; name: string; identity: VaultIdentity | null }[], threshold: number, stepUp: string | undefined) {
  const { id, tenant, user, generation } = me();
  if (people.some((p) => !p.identity)) throw new SealedError('Everyone in the circle needs vault keys first.');
  for (const p of people) {
    if (!verifyBundle(asBundle(p.identity!))) throw new SealedError(`${p.name}'s keys on record are not valid.`);
    if (pins.check(tenant, p.userId, p.identity!.fingerprint, p.identity!.ed25519Public) === 'changed') throw new SealedError(`${p.name}'s key changed since this device last saw it. Compare safety codes with them first.`);
  }
  const shares = split(id.seed, people.length, threshold);
  try {
    const sealedShares = [];
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const env = await sealTo(p.identity!, shares[i], circleContext(tenant, user, p.userId, generation), id);
      sealedShares.push({ trusteeUserId: p.userId, trusteeGeneration: p.identity!.generation, envelope: env.envelope, signature: env.signature });
      pins.accept(tenant, p.userId, p.identity!.fingerprint, p.identity!.ed25519Public);
    }
    return await vaultApi.setCircle({ threshold, shares: sealedShares, stepUp });
  } finally { wipe(...shares); }
}

/** On a browser that cannot unlock: one-time keys, the request to the circle, and the code each helper compares with this person. */
export async function startRecovery(label: string) {
  const eph = ephemeralKeys();
  const status = await vaultApi.startRecovery({ label, x25519Public: eph.x25519Public, mlKemPublic: eph.mlKemPublic });
  return { status, eph, code: linkCode(eph.x25519Public, eph.mlKemPublic) };
}

/** Waits for enough shares, checks each was signed by the colleague who sent it, puts the secret back together and unlocks — only if it gives the keys on record. */
export async function waitForRecovery(tenant: string, user: string, keys: VaultKeysMe, started: Awaited<ReturnType<typeof startRecovery>>, signal: AbortSignal,
  onProgress?: (got: number, need: number, refused: number) => void) {
  const shares: Uint8Array[] = [];
  try {
    while (!signal.aborted) {
      const s = await vaultApi.recoveryStatus(started.status.id);
      if (s.cancelled) throw new SealedError('The request was cancelled.');
      if (Date.parse(s.expiresAt) < Date.now()) throw new SealedError('The request ran out of time. Ask again.');
      wipe(...shares); shares.length = 0;
      for (const r of s.releases) {
        if (!r.envelope || !r.signature || !r.trusteeEd25519Public) continue;
        const ctx = releaseContext(tenant, user, s.id, r.trustee.id);
        if (!verifyEnvelope(r.trusteeEd25519Public, { envelope: r.envelope, signature: r.signature }, ctx)) continue;   // not from them: ignored
        try { shares.push(await openFrom(started.eph, r.envelope, ctx)); } catch { /* damaged: ignored */ }
      }
      const refused = s.releases.filter((r) => r.refused).length;
      onProgress?.(shares.length, s.threshold, refused);
      if (s.threshold >= 2 && shares.length >= s.threshold) {
        // Any `threshold` of them give the secret; try groups until one gives exactly the keys on record (a bad share only spoils its groups).
        for (const group of groups(shares, s.threshold)) {
          const seed = combine(group);
          const probe = deriveIdentity(new Uint8Array(seed));
          const ok = !!keys.identity && matches(probe, asBundle(keys.identity));
          forget(probe);
          if (!ok) { wipe(seed); continue; }
          accept(tenant, user, keys, seed, '', 'recovery circle');   // the keyring keeps this secret now: not wiped here
          await vaultApi.finishRecovery(s.id, true).catch(() => undefined);
          return;
        }
        if (shares.length >= s.helpers) throw new SealedError('The shares that came back do not give your keys. Ask an admin to reset your vault keys.');
      }
      if (s.helpers - refused < s.threshold) throw new SealedError('Too many people refused: the circle cannot give your key back this time.');
      await new Promise((r) => setTimeout(r, 2500));
    }
  } finally { wipe(started.eph.xPriv, started.eph.kemSec, ...shares); }
}

function* groups<T>(xs: T[], k: number, start = 0, acc: T[] = []): Generator<T[]> {
  if (acc.length === k) { yield [...acc]; return; }
  for (let i = start; i < xs.length; i++) yield* groups(xs, k, i + 1, [...acc, xs[i]]);
}

/** A colleague helps, after comparing the code with the person: their share is opened here and re-encrypted to the asking browser's one-time keys. */
export async function helpRecovery(req: VaultRecoveryToHelp) {
  const { id, tenant, user } = me();
  const shareCtx = circleContext(tenant, req.person.id, user, req.ownerGeneration);
  if (!verifyEnvelope(req.ownerEd25519Public, { envelope: req.shareEnvelope, signature: req.shareSignature }, shareCtx)) throw new SealedError('This share was not signed by their vault keys. Nothing was sent.');
  const share = await openFrom(id, req.shareEnvelope, shareCtx);
  try {
    const env = await sealTo({ x25519Public: req.x25519Public, mlKemPublic: req.mlKemPublic }, share, releaseContext(tenant, req.person.id, req.requestId, user), id);
    await vaultApi.helpRecovery(req.requestId, env.envelope, env.signature);
  } finally { wipe(share); }
}

// ------------------------------------------------------------------ collection keys

export interface OpenResult { state: 'open' | 'waiting' | 'unreadable'; warning: string | null; keys: CollectionKeys }

/** Opens a sealed collection's keys (every version this person holds), checking each envelope's signature and the sender's pinned key. */
export async function openCollection(c: VaultCollection): Promise<OpenResult> {
  const { id, tenant, user, generation } = me();
  let keys = await vaultApi.collectionKeys(c.id);
  let warning: string | null = null;
  for (const e of keys.mine) {
    if (keyring.collectionKey(c.id, e.keyVersion)) continue;
    if (e.recipientGeneration !== generation) continue;
    const ctx = ckContext(tenant, c.id, e.keyVersion, user, generation);
    const signer = e.senderUserId === user ? b64(id.edPub) : e.senderEd25519Public;
    if (!signer || !verifyEnvelope(signer, e, ctx)) { warning = 'A key for this collection was not signed by who the server says shared it. It was not used.'; continue; }
    if (e.senderUserId !== user && pins.check(tenant, e.senderUserId, '', signer) === 'changed' && !(await pinnedEd(tenant, e.senderUserId, signer))) warning = 'The key of the person who shared this changed since you last saw it. Compare safety codes with them.';
    try { keyring.setCollectionKey(c.id, e.keyVersion, await openFrom(id, e.envelope, ctx)); }
    catch { warning = 'One of your keys for this collection could not be opened.'; }
  }
  if (keys.myAccess === 'Manage') {
    if (keys.rekeyNeeded && keyring.collectionKey(c.id, keys.keyVersion)) { await rekey(c, keys); keys = await vaultApi.collectionKeys(c.id); }
    if ((keys.pending ?? []).some((p) => p.identity)) keys = await shareKey(c, keys) ?? keys;
  }
  const open = !!keyring.collectionKey(c.id, keys.keyVersion);
  return { state: open ? 'open' : keys.mine.length ? 'unreadable' : 'waiting', warning, keys };
}
async function pinnedEd(tenant: string, user: string, ed: string) {
  const dir = await vaultApi.directory([user]).catch(() => []);
  const who = dir[0]?.identity;
  return !!who && who.ed25519Public === ed && pins.check(tenant, user, who.fingerprint, ed) !== 'changed';
}

/** Wraps the current collection key to everyone with access who has keys and does not have it yet (checked keys only). */
export async function shareKey(c: VaultCollection, keys: CollectionKeys): Promise<CollectionKeys | null> {
  const { id, tenant } = me();
  const ck = keyring.collectionKey(c.id, keys.keyVersion);
  if (!ck) return null;
  const out: EnvelopeInput[] = [];
  for (const p of keys.pending ?? []) {
    if (!p.identity || !verifyBundle(asBundle(p.identity))) continue;
    const pin = pins.check(tenant, p.userId, p.identity.fingerprint, p.identity.ed25519Public);
    if (pin === 'changed') continue;   // shown in the access list: someone must compare safety codes first
    if (pin === 'new') pins.accept(tenant, p.userId, p.identity.fingerprint, p.identity.ed25519Public);
    const env = await sealTo(p.identity, ck, ckContext(tenant, c.id, keys.keyVersion, p.userId, p.identity.generation), id);
    out.push({ recipientUserId: p.userId, keyVersion: keys.keyVersion, recipientGeneration: p.identity.generation, ...env });
  }
  return out.length ? vaultApi.saveEnvelopes(c.id, out) : null;
}

/** The pending people whose key changed since this device last saw it (to compare safety codes before sharing with them). */
export function changedKeys(keys: CollectionKeys) {
  const s = keyring.get();
  return (keys.pending ?? []).filter((p) => p.identity && s.tenant && pins.check(s.tenant, p.userId, p.identity.fingerprint, p.identity.ed25519Public) === 'changed');
}

/** After someone lost access: a new key, with every item, earlier value and file key re-encrypted under it, sent all at once. */
export async function rekey(c: VaultCollection, keys: CollectionKeys) {
  const { id, tenant, user, generation } = me();
  const live = await vaultApi.sealedItems(c.id), binned = await vaultApi.sealedItems(c.id, true);
  const rows = [...live, ...binned];
  const ck2 = random(32), version = keys.keyVersion + 1;
  const keyFor = (v: number) => { const k = keyring.collectionKey(c.id, v); if (!k) throw new SealedError(`Key ${v} of this collection is missing on this device.`); return k; };
  const items: { id: string; blob: string }[] = [], versions: { id: string; blob: string }[] = [], files: { id: string; blob: string }[] = [];
  for (const r of rows) {
    const ctx = itemContext(tenant, c.id, r.id);
    const plain = await aesOpen(keyFor(r.keyVersion), unb64(r.blob), ctx);
    items.push({ id: r.id, blob: b64(await aesSeal(ck2, plain, ctx)) }); wipe(plain);
    if (r.versions > 0) for (const v of await vaultApi.sealedVersions(r.id)) {
      const p = await aesOpen(keyFor(v.keyVersion), unb64(v.blob), ctx);
      versions.push({ id: v.id, blob: b64(await aesSeal(ck2, p, ctx)) }); wipe(p);
    }
    for (const f of r.files) {
      const { fileKey, name } = await unwrapFile(keyFor(f.keyVersion), tenant, r.id, f.wrapped);
      files.push({ id: f.id, blob: await wrapFile(ck2, tenant, r.id, fileKey, name) }); wipe(fileKey);
    }
  }
  const env = await sealTo({ x25519Public: b64(id.xPub), mlKemPublic: b64(id.kemPub) }, ck2, ckContext(tenant, c.id, version, user, generation), id);
  await vaultApi.rekey(c.id, { newVersion: version, envelopes: [{ recipientUserId: user, keyVersion: version, recipientGeneration: generation, ...env }], items, versions, files });
  keyring.setCollectionKey(c.id, version, ck2);
}

/** A new sealed collection's first key, for its maker. */
export async function firstKey(collectionId: string) {
  const { id, tenant, user, generation } = me();
  const ck = random(32);
  const env = await sealTo({ x25519Public: b64(id.xPub), mlKemPublic: b64(id.kemPub) }, ck, ckContext(tenant, collectionId, 1, user, generation), id);
  await vaultApi.saveEnvelopes(collectionId, [{ recipientUserId: user, keyVersion: 1, recipientGeneration: generation, ...env }]);
  keyring.setCollectionKey(collectionId, 1, ck);
}

// ------------------------------------------------------------------ items

export async function listSealed(c: VaultCollection, bin = false): Promise<SealedItem[]> {
  const { tenant } = me();
  const rows = await vaultApi.sealedItems(c.id, bin);
  return Promise.all(rows.map(async (row) => {
    const ck = keyring.collectionKey(c.id, row.keyVersion);
    if (!ck) return { row, payload: null, error: 'Its key is not on this device.' };
    try { return { row, payload: JSON.parse(fromUtf8(await aesOpen(ck, unb64(row.blob), itemContext(tenant, c.id, row.id)))) as SealedPayload, error: null }; }
    catch { return { row, payload: null, error: 'This item could not be decrypted.' }; }
  }));
}

export async function saveSealed(c: VaultCollection, existing: SealedItemRow | null, kind: VaultItemKind, payload: SealedPayload,
  meta: { expiresAt: string | null; rotateEveryDays: number | null; valueChanged: boolean; reason: string | null }) {
  const { tenant } = me();
  const keys = await vaultApi.collectionKeys(c.id);
  const ck = keyring.collectionKey(c.id, keys.keyVersion);
  if (!ck) throw new SealedError('This collection’s key is not on this device yet.');
  const itemId = existing?.id ?? crypto.randomUUID();
  const blob = b64(await aesSeal(ck, utf8(JSON.stringify(payload)), itemContext(tenant, c.id, itemId)));
  return existing
    ? vaultApi.updateSealed(itemId, { collectionId: c.id, kind, keyVersion: keys.keyVersion, blob, expiresAt: meta.expiresAt, rotateEveryDays: meta.rotateEveryDays, valueChanged: meta.valueChanged, reason: meta.reason })
    : vaultApi.createSealed({ id: itemId, collectionId: c.id, kind, keyVersion: keys.keyVersion, blob, expiresAt: meta.expiresAt, rotateEveryDays: meta.rotateEveryDays });
}

export async function sealedHistory(c: VaultCollection, itemId: string) {
  const { tenant } = me();
  const rows = await vaultApi.sealedVersions(itemId);
  return Promise.all(rows.map(async (v) => {
    const ck = keyring.collectionKey(c.id, v.keyVersion);
    const payload = ck ? JSON.parse(fromUtf8(await aesOpen(ck, unb64(v.blob), itemContext(tenant, c.id, itemId)))) as SealedPayload : null;
    return { ...v, payload };
  }));
}

// Files: each has its own key; the collection key wraps that key and the file's name (so a new collection key only re-wraps, never re-uploads).
async function wrapFile(ck: Uint8Array, tenant: string, item: string, fileKey: Uint8Array, name: string) {
  const k = await aesSeal(ck, fileKey, `filekey|${tenant}|${item}`);
  const n = await aesSeal(ck, utf8(name.slice(0, 100)), `filename|${tenant}|${item}`);
  return b64(concat(Uint8Array.of(k.length >> 8, k.length & 255), k, n));
}
async function unwrapFile(ck: Uint8Array, tenant: string, item: string, wrapped: string) {
  const raw = unb64(wrapped), len = (raw[0] << 8) | raw[1];
  return { fileKey: await aesOpen(ck, raw.subarray(2, 2 + len), `filekey|${tenant}|${item}`), name: fromUtf8(await aesOpen(ck, raw.subarray(2 + len), `filename|${tenant}|${item}`)) };
}
export async function fileName(c: VaultCollection, item: string, f: SealedFile) {
  const { tenant } = me();
  const ck = keyring.collectionKey(c.id, f.keyVersion);
  if (!ck) return 'File';
  try { const { fileKey, name } = await unwrapFile(ck, tenant, item, f.wrapped); wipe(fileKey); return name; } catch { return 'File'; }
}
export async function uploadSealedFile(c: VaultCollection, item: SealedItemRow, file: File) {
  const { tenant } = me();
  const keys = await vaultApi.collectionKeys(c.id);
  const ck = keyring.collectionKey(c.id, keys.keyVersion);
  if (!ck) throw new SealedError('This collection’s key is not on this device yet.');
  const fileKey = random(32);
  try {
    const cipher = await aesSeal(fileKey, new Uint8Array(await file.arrayBuffer()), `file|${tenant}|${item.id}`);
    return await vaultApi.addSealedFile(item.id, new Blob([cipher]), await wrapFile(ck, tenant, item.id, fileKey, file.name));
  } finally { wipe(fileKey); }
}
export async function downloadSealedFile(c: VaultCollection, item: SealedItemRow, f: SealedFile) {
  const { tenant } = me();
  const ck = keyring.collectionKey(c.id, f.keyVersion);
  if (!ck) throw new SealedError('This file’s key is not on this device.');
  const { fileKey, name } = await unwrapFile(ck, tenant, item.id, f.wrapped);
  try { await saveFile(new Blob([await aesOpen(fileKey, await vaultApi.sealedFile(f.id), `file|${tenant}|${item.id}`)]), name); }
  finally { wipe(fileKey); }
}

// ------------------------------------------------------------------ sealing a guarded collection

/** Moves a guarded collection to sealed: its values come out once (two-step, recorded), are encrypted here, and the readable copies are destroyed. */
export async function sealCollection(c: VaultCollection, stepUp: string | undefined) {
  const { id, tenant, user, generation } = me();
  const items = await vaultApi.exportForSealing(c.id, stepUp);
  const ck = random(32);
  const out: { id: string; blob: string }[] = [], files: { id: string; wrapped: string; cipher: string }[] = [];
  for (const i of items) {
    const payload: SealedPayload = { v: 1, title: i.title, url: i.url, tags: i.tags, class: i.class, fields: i.fields, links: [] };
    out.push({ id: i.id, blob: b64(await aesSeal(ck, utf8(JSON.stringify(payload)), itemContext(tenant, c.id, i.id))) });
    for (const f of i.files) {
      const fileKey = random(32);
      files.push({ id: f.id, wrapped: await wrapFile(ck, tenant, i.id, fileKey, f.fileName), cipher: b64(await aesSeal(fileKey, unb64(f.data), `file|${tenant}|${i.id}`)) });
      wipe(fileKey);
    }
  }
  const env = await sealTo({ x25519Public: b64(id.xPub), mlKemPublic: b64(id.kemPub) }, ck, ckContext(tenant, c.id, 1, user, generation), id);
  const keys = await vaultApi.seal(c.id, { stepUp, envelope: { recipientUserId: user, keyVersion: 1, recipientGeneration: generation, ...env }, items: out, files });
  keyring.setCollectionKey(c.id, 1, ck);
  return { items: items.length, keys };
}

// ------------------------------------------------------------------ breach check without sending the password

export async function breachesFor(password: string): Promise<number> {
  const { prefix, suffix } = breachParts(password);
  const { body } = await vaultApi.breachRange(prefix);
  return breachCount(body, suffix);
}

export type { Identity };
