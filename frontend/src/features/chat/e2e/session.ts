/**
 * This device's private-chat identity (kept in IndexedDB, per workspace and person) and the glue between the chat API and the crypto:
 * encrypting a message for a private conversation before it leaves, and opening encrypted messages as they arrive. Plaintext only ever goes
 * to the screen; it is never logged, cached in storage or sent anywhere.
 */
import { del, get, post, put } from '../../../api/client';
import type { ChatMessage } from '../../../api/types';
import { useAuth } from '../../../stores/auth';
import { generateDevice, lockPrivateKey, makeBackup, newDeviceId, open, restoreBackup, seal, type Backup, type DeviceIdentity, type DeviceKey } from './crypto';

const DB = 'pt-e2e';
const STORE = 'devices';

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('This browser cannot keep private-chat keys.')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction(STORE, mode);
      const r = run(tx.objectStore(STORE));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      tx.oncomplete = () => req.result.close();
    };
  });
}

function slot(): string | null {
  const c = useAuth.getState().ctx;
  return c?.current && c.user ? `${c.current.id}:${c.user.id}` : null;
}

let cached: { slot: string; id: DeviceIdentity } | null = null;

/** This device's identity, or null when private chat has not been set up (or restored) here. */
export async function deviceIdentity(): Promise<DeviceIdentity | null> {
  const s = slot();
  if (!s) return null;
  if (cached?.slot === s) return cached.id;
  try {
    const row = await idb<DeviceIdentity | undefined>('readonly', (st) => st.get(s) as IDBRequest<DeviceIdentity | undefined>);
    if (row) cached = { slot: s, id: row };
    return row ?? null;
  } catch { return null; }
}

async function keep(id: DeviceIdentity) {
  const s = slot();
  if (!s) throw new Error('Sign in again.');
  await idb('readwrite', (st) => st.put(id, s));
  cached = { slot: s, id };
}

const deviceLabel = () => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const os = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  return `${os} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
};

export const e2eApi = {
  me: () => get<{ devices: (DeviceKey & { label: string | null; createdAt: string })[]; hasBackup: boolean }>('/chat/keys/me'),
  backup: () => get<Backup | null>('/chat/keys/backup'),
  saveBackup: (b: Backup) => put('/chat/keys/backup', b),
  register: (deviceId: string, publicKey: string) => put('/chat/keys/devices', { deviceId, publicKey, label: deviceLabel() }),
  revoke: (deviceId: string) => del(`/chat/keys/devices/${deviceId}`),
  conversationKeys: (id: string) => get<DeviceKey[]>(`/chat/conversations/${id}/keys`),
  peopleKeys: (userIds: string[]) => post<DeviceKey[]>('/chat/keys/lookup', { userIds }),
  setPrivate: (id: string, enabled: boolean) => put(`/chat/conversations/${id}/private`, { enabled }),
};

/** First device: a new key pair, protected by a recovery passphrase the person chooses (needed to read private chats on a new device). */
export async function setUpDevice(passphrase: string): Promise<DeviceIdentity> {
  const { pair, publicJwk } = await generateDevice();
  const backup = await makeBackup(pair, publicJwk, passphrase);
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const privateKey = await lockPrivateKey(pkcs8);
  pkcs8.fill(0);
  const id: DeviceIdentity = { deviceId: newDeviceId(), privateKey, publicJwk };
  await e2eApi.saveBackup(backup);
  await e2eApi.register(id.deviceId, publicJwk);
  await keep(id);
  return id;
}

/** Another device: opens the recovery copy with the passphrase and registers this browser with that key. */
export async function restoreDevice(passphrase: string): Promise<DeviceIdentity> {
  const b = await e2eApi.backup();
  if (!b) throw new Error('There is no recovery copy yet. Set up private chat instead.');
  const privateKey = await restoreBackup(b, passphrase);
  const id: DeviceIdentity = { deviceId: newDeviceId(), privateKey, publicJwk: b.publicKey };
  await e2eApi.register(id.deviceId, b.publicKey);
  await keep(id);
  return id;
}

/** Forgets the key on this device (it can be restored with the passphrase) and stops others encrypting for it. */
export async function forgetDevice() {
  const id = await deviceIdentity();
  const s = slot();
  if (id) await e2eApi.revoke(id.deviceId).catch(() => undefined);
  if (s) await idb('readwrite', (st) => st.delete(s)).catch(() => undefined);
  cached = null;
}

// ------------------------------------------------------------------ messages

const privateConversations = new Set<string>();
/** Remembers which conversations are private (from every conversation the API returns), so a send knows to encrypt. */
export function notePrivacy(c: { id: string; isPrivate?: boolean } | null | undefined) {
  if (!c) return;
  if (c.isPrivate) privateConversations.add(c.id); else privateConversations.delete(c.id);
}
export const isPrivateConversation = (id: string) => privateConversations.has(id);

/** Encrypts a message for every device in the conversation. Throws (with a reason to show) when this device has no key yet. */
export async function sealFor(conversationId: string, text: string): Promise<string> {
  const me = await deviceIdentity();
  if (!me) throw new Error('Set up private chat on this device first (Messages › 🔒 Private chat).');
  const keys = await e2eApi.conversationKeys(conversationId);
  return seal(JSON.stringify({ t: text }), me, keys, conversationId);
}

export type E2eState = 'ok' | 'locked' | 'unreadable';
export type OpenedMessage = ChatMessage & { e2e?: E2eState };

/** An encrypted message with its text in `body` (or a short note why it cannot be read here). Other messages are returned unchanged. */
export async function openMessage<M extends ChatMessage>(m: M): Promise<M & { e2e?: E2eState }> {
  if (!m?.cipher || m.isDeleted) return m;
  const me = await deviceIdentity();
  if (!me) return { ...m, body: '🔒 Encrypted. Restore private chat on this device to read it.', e2e: 'locked' };
  const r = await open(m.cipher, me, m.conversationId);
  if (!r.ok) return { ...m, body: r.reason === 'not-for-this-device' ? '🔒 Sent before this device was set up.' : '🔒 This message could not be decrypted.', e2e: 'unreadable' };
  let text = '';
  try { text = String((JSON.parse(r.text) as { t?: unknown }).t ?? ''); } catch { text = ''; }
  return { ...m, body: text, e2e: 'ok' };
}

export const openAll = <M extends ChatMessage>(items: M[]) => Promise.all(items.map((m) => openMessage(m)));
