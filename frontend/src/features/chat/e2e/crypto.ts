/**
 * End-to-end encryption for private chats and private calls, with the browser's own WebCrypto only (no libraries).
 *
 *  - Each device has an ECDH P-256 key pair. The private key lives in IndexedDB as a non-extractable CryptoKey; only the public key (JWK) is
 *    sent to the server.
 *  - A message is encrypted once with a fresh AES-256-GCM key (the conversation id is bound in as associated data), and that key is wrapped
 *    for every recipient device: ECDH(sender device, recipient device) → HKDF-SHA-256 (salt: the message IV) → AES-256-GCM.
 *  - The recovery copy is the private key (PKCS#8) encrypted with AES-256-GCM under PBKDF2-SHA-256 (600,000 rounds) of the person's passphrase.
 *
 * Nothing in here logs, and nothing returns plaintext anywhere but to its caller.
 */

export const ENVELOPE_VERSION = 1;
export const PBKDF2_ROUNDS = 600_000;
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface DeviceKey { userId: string; deviceId: string; publicKey: string }
export interface EnvelopeKey { d: string; iv: string; k: string }
export interface Envelope { v: 1; iv: string; ct: string; from: string; fpub: string; keys: EnvelopeKey[] }
export interface DeviceIdentity { deviceId: string; privateKey: CryptoKey; publicJwk: string }

// ------------------------------------------------------------------ bytes

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
export const newDeviceId = () => b64(randomBytes(16));

// ------------------------------------------------------------------ device keys

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

/** A new key pair. `extractable` only so the private key can be put in a recovery copy right away; it is stored non-extractable. */
export async function generateDevice(): Promise<{ pair: CryptoKeyPair; publicJwk: string }> {
  const pair = await subtle().generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair;
  return { pair, publicJwk: await publicJwkOf(pair.publicKey) };
}

export async function publicJwkOf(key: CryptoKey): Promise<string> {
  const j = await subtle().exportKey('jwk', key);
  return JSON.stringify({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
}

/** The private key again, this time non-extractable (what is kept in IndexedDB). */
export async function lockPrivateKey(pkcs8: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey('pkcs8', pkcs8, ECDH, false, ['deriveBits']);
}

const importPublic = (jwk: string) => subtle().importKey('jwk', JSON.parse(jwk) as JsonWebKey, ECDH, false, []);

async function wrapKeyFor(mine: CryptoKey, theirs: string, salt: Uint8Array<ArrayBuffer>, info: string): Promise<CryptoKey> {
  const shared = await subtle().deriveBits({ name: 'ECDH', public: await importPublic(theirs) }, mine, 256);
  const hk = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ------------------------------------------------------------------ messages

/**
 * Encrypts `plaintext` for every device in `recipients` (include the sender's own devices so they can read their history).
 * `context` (the conversation or call id) is bound in: an envelope moved to another conversation does not open.
 */
export async function seal(plaintext: string, me: DeviceIdentity, recipients: DeviceKey[], context: string): Promise<string> {
  if (recipients.length === 0) throw new Error('Nobody here has set up private chat on a device yet.');
  const raw = randomBytes(32);
  const iv = randomBytes(12);
  const msgKey = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, msgKey, enc.encode(plaintext));
  const keys: EnvelopeKey[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    if (seen.has(r.deviceId)) continue;
    seen.add(r.deviceId);
    const kiv = randomBytes(12);
    const wk = await wrapKeyFor(me.privateKey, r.publicKey, iv, `pt-e2e-v1|${context}|${r.deviceId}`);
    keys.push({ d: r.deviceId, iv: b64(kiv), k: b64(await subtle().encrypt({ name: 'AES-GCM', iv: kiv }, wk, raw)) });
  }
  raw.fill(0);
  const env: Envelope = { v: ENVELOPE_VERSION, iv: b64(iv), ct: b64(ct), from: me.deviceId, fpub: me.publicJwk, keys };
  return JSON.stringify(env);
}

export type OpenResult = { ok: true; text: string; fromDevice: string; fromKey: string } | { ok: false; reason: 'not-for-this-device' | 'damaged' };

/** Opens an envelope with this device's key. Never throws: a message for another device, or a damaged one, says so. */
export async function open(cipher: string, me: DeviceIdentity, context: string): Promise<OpenResult> {
  let env: Envelope;
  try { env = JSON.parse(cipher) as Envelope; } catch { return { ok: false, reason: 'damaged' }; }
  if (env?.v !== ENVELOPE_VERSION || !Array.isArray(env.keys)) return { ok: false, reason: 'damaged' };
  const entry = env.keys.find((k) => k.d === me.deviceId);
  if (!entry) return { ok: false, reason: 'not-for-this-device' };
  try {
    const iv = unb64(env.iv);
    const wk = await wrapKeyFor(me.privateKey, env.fpub, iv, `pt-e2e-v1|${context}|${me.deviceId}`);
    const raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(entry.iv) }, wk, unb64(entry.k)));
    const msgKey = await subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    raw.fill(0);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(context) }, msgKey, unb64(env.ct));
    return { ok: true, text: dec.decode(pt), fromDevice: env.from, fromKey: env.fpub };
  } catch { return { ok: false, reason: 'damaged' }; }
}

// ------------------------------------------------------------------ recovery copy

async function passphraseKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, rounds: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export interface Backup { salt: string; iterations: number; wrappedKey: string; publicKey: string }

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.trim().length < 12) return 'Use at least 12 characters - a short sentence is easiest to remember.';
  if (new Set(passphrase).size < 6) return 'Use more different characters.';
  return null;
}

export async function makeBackup(pair: CryptoKeyPair, publicJwk: string, passphrase: string, rounds = PBKDF2_ROUNDS): Promise<Backup> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await passphraseKey(passphrase, salt, rounds);
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(publicJwk) }, key, pkcs8);
  pkcs8.fill(0);
  return { salt: b64(salt), iterations: rounds, wrappedKey: `${b64(iv)}.${b64(ct)}`, publicKey: publicJwk };
}

/** The private key from a recovery copy, non-extractable. Throws "wrong passphrase" when it does not open. */
export async function restoreBackup(b: Backup, passphrase: string): Promise<CryptoKey> {
  const [iv, ct] = b.wrappedKey.split('.');
  try {
    const key = await passphraseKey(passphrase, unb64(b.salt), b.iterations);
    const pkcs8 = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(b.publicKey) }, key, unb64(ct)));
    try { return await lockPrivateKey(pkcs8); } finally { pkcs8.fill(0); }
  } catch { throw new Error('That passphrase does not open your recovery copy.'); }
}

// ------------------------------------------------------------------ private calls

/** A fresh room key for a private call (LiveKit E2EE takes it as a string). */
export const newRoomKey = () => b64(randomBytes(32));
