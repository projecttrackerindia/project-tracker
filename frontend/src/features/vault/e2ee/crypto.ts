/**
 * The sealed vault's cryptography, all of it in the browser.
 *
 * - One 32-byte identity secret per person and workspace. From it (HKDF-SHA-256, separate labels) come an X25519 key, an ML-KEM-768 key
 *   (FIPS 203, post-quantum) and an Ed25519 signing key. Only the public halves go to the server.
 * - The secret itself is stored only wrapped (AES-256-GCM) under a key from a passkey (WebAuthn PRF) or from the printed recovery key
 *   (Argon2id). The server never sees it, the PRF output or the recovery key.
 * - A collection key (32 random bytes) reaches a member as an envelope: X25519 and ML-KEM-768 each give a shared secret, both go through
 *   HKDF into the key that wraps it (so it stays safe if either one is ever broken), and the sharer signs the envelope with Ed25519.
 * - Items are AES-256-GCM under the collection key, bound by their associated data to the workspace, collection and item, so the server
 *   cannot move ciphertext between items or collections unnoticed.
 */
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

const te = new TextEncoder(), td = new TextDecoder();
export const utf8 = (s: string) => te.encode(s);
export const fromUtf8 = (b: Uint8Array) => td.decode(b);
/** A copy backed by a plain ArrayBuffer (what WebCrypto accepts). */
const ab = (u: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(u);
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const wipe = (...xs: (Uint8Array | null | undefined)[]) => { for (const x of xs) x?.fill(0); };

export function b64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ------------------------------------------------------------------ AES-256-GCM (format: 0x01 | nonce 12 | ciphertext+tag)

async function aesKey(raw: Uint8Array) { return crypto.subtle.importKey('raw', ab(raw), 'AES-GCM', false, ['encrypt', 'decrypt']); }
export async function aesSeal(key: Uint8Array, plain: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: ab(utf8(aad)) }, await aesKey(key), ab(plain)));
  return concat(Uint8Array.of(1), iv, ct);
}
export async function aesOpen(key: Uint8Array, data: Uint8Array, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (data[0] !== 1 || data.length < 29) throw new VaultCryptoError('Unknown or damaged ciphertext.');
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(data.subarray(1, 13)), additionalData: ab(utf8(aad)) }, await aesKey(key), ab(data.subarray(13)))); }
  catch { throw new VaultCryptoError('This could not be decrypted: wrong key, or the data was changed.'); }
}
export class VaultCryptoError extends Error {}

// ------------------------------------------------------------------ identity

export interface Identity { seed: Uint8Array; xPriv: Uint8Array; xPub: Uint8Array; edPriv: Uint8Array; edPub: Uint8Array; kemSec: Uint8Array; kemPub: Uint8Array }
export interface PublicBundle { x25519Public: string; mlKemPublic: string; ed25519Public: string; selfSignature: string; fingerprint: string }

export function deriveIdentity(seed: Uint8Array): Identity {
  if (seed.length !== 32) throw new VaultCryptoError('An identity secret is 32 bytes.');
  const xPriv = hkdf(sha256, seed, undefined, utf8('pt-vault/x25519/v1'), 32);
  const edPriv = hkdf(sha256, seed, undefined, utf8('pt-vault/ed25519/v1'), 32);
  const kem = ml_kem768.keygen(hkdf(sha256, seed, undefined, utf8('pt-vault/ml-kem-768/v1'), 64));
  return { seed, xPriv, xPub: x25519.getPublicKey(xPriv), edPriv, edPub: ed25519.getPublicKey(edPriv), kemSec: kem.secretKey, kemPub: kem.publicKey };
}
export const forget = (id: Identity | null | undefined) => { if (id) wipe(id.seed, id.xPriv, id.edPriv, id.kemSec); };

/** Twelve groups of five digits from SHA-512 of the three public keys (people read them aloud to check nobody swapped a key). */
export function safetyCode(xPub: Uint8Array, kemPub: Uint8Array, edPub: Uint8Array): string {
  const h = sha512(concat(utf8('pt-vault/safety-code/v1'), xPub, kemPub, edPub));
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    let n = 0; for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}
const bundleBytes = (xPub: Uint8Array, kemPub: Uint8Array, edPub: Uint8Array) => sha256(concat(utf8('pt-vault/bundle/v1'), xPub, kemPub, edPub));
export function publicBundle(id: Identity): PublicBundle {
  return {
    x25519Public: b64(id.xPub), mlKemPublic: b64(id.kemPub), ed25519Public: b64(id.edPub),
    selfSignature: b64(ed25519.sign(bundleBytes(id.xPub, id.kemPub, id.edPub), id.edPriv)), fingerprint: safetyCode(id.xPub, id.kemPub, id.edPub),
  };
}
/** A bundle from the server is accepted only if its signature checks and its safety code is the one its keys give. */
export function verifyBundle(b: PublicBundle): boolean {
  try {
    const x = unb64(b.x25519Public), k = unb64(b.mlKemPublic), e = unb64(b.ed25519Public);
    return x.length === 32 && k.length === 1184 && e.length === 32 && ed25519.verify(unb64(b.selfSignature), bundleBytes(x, k, e), e) && safetyCode(x, k, e) === b.fingerprint;
  } catch { return false; }
}
/** The keys a secret gives are exactly the ones on the server (a changed secret, or a changed server record, is refused). */
export function matches(id: Identity, b: PublicBundle) { return b64(id.xPub) === b.x25519Public && b64(id.kemPub) === b.mlKemPublic && b64(id.edPub) === b.ed25519Public; }

// ------------------------------------------------------------------ hybrid envelopes (X25519 + ML-KEM-768, signed with Ed25519)

const KEM_CT = 1088;
export interface Envelope { envelope: string; signature: string }

export async function sealTo(to: { x25519Public: string; mlKemPublic: string }, payload: Uint8Array, context: string, signer: Identity): Promise<Envelope> {
  const xPub = unb64(to.x25519Public), kemPub = unb64(to.mlKemPublic);
  if (xPub.length !== 32 || kemPub.length !== 1184) throw new VaultCryptoError('Their public keys are not valid.');
  const eph = x25519.utils.randomSecretKey();
  const ephPub = x25519.getPublicKey(eph);
  const ss1 = x25519.getSharedSecret(eph, xPub);
  const { cipherText, sharedSecret: ss2 } = ml_kem768.encapsulate(kemPub);
  const key = hkdf(sha256, concat(ss1, ss2), concat(ephPub, sha256(cipherText)), utf8(`pt-vault/wrap/v1|${context}`), 32);
  try {
    const env = concat(Uint8Array.of(1), ephPub, cipherText, await aesSeal(key, payload, context));
    return { envelope: b64(env), signature: b64(ed25519.sign(sha256(concat(utf8(context), env)), signer.edPriv)) };
  } finally { wipe(eph, ss1, ss2, key); }
}

export async function openFrom(me: { xPriv: Uint8Array; kemSec: Uint8Array }, envelope: string, context: string): Promise<Uint8Array<ArrayBuffer>> {
  const env = unb64(envelope);
  if (env[0] !== 1 || env.length < 1 + 32 + KEM_CT + 29) throw new VaultCryptoError('Unknown or damaged key envelope.');
  const ephPub = env.subarray(1, 33), kemCt = env.subarray(33, 33 + KEM_CT);
  const ss1 = x25519.getSharedSecret(me.xPriv, ephPub);
  const ss2 = ml_kem768.decapsulate(kemCt, me.kemSec);
  const key = hkdf(sha256, concat(ss1, ss2), concat(ephPub, sha256(kemCt)), utf8(`pt-vault/wrap/v1|${context}`), 32);
  try { return await aesOpen(key, env.subarray(33 + KEM_CT), context); } finally { wipe(ss1, ss2, key); }
}

export function verifyEnvelope(senderEd25519Public: string, e: Envelope, context: string): boolean {
  try { return ed25519.verify(unb64(e.signature), sha256(concat(utf8(context), unb64(e.envelope))), unb64(senderEd25519Public)); } catch { return false; }
}

export const ckContext = (tenant: string, collection: string, version: number, recipient: string, generation: number) => `ck|${tenant}|${collection}|v${version}|${recipient}|g${generation}`;
export const deviceContext = (tenant: string, user: string, link: string) => `device|${tenant}|${user}|${link}`;
export const seedContext = (tenant: string, user: string, kind: 'Passkey' | 'RecoveryKey') => `seed|${tenant}|${user}|${kind}`;
export const itemContext = (tenant: string, collection: string, item: string) => `item|${tenant}|${collection}|${item}`;
/** A recovery-circle share from its owner to one colleague, bound to both people and the owner's key generation. */
export const circleContext = (tenant: string, owner: string, trustee: string, generation: number) => `circle|${tenant}|${owner}|${trustee}|g${generation}`;
/** That colleague's share, passed on to the browser that asked for help (bound to the request). */
export const releaseContext = (tenant: string, owner: string, request: string, trustee: string) => `circle-release|${tenant}|${owner}|${request}|${trustee}`;

// ------------------------------------------------------------------ unlocking: recovery key (Argon2id) and passkey (WebAuthn PRF)

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0, 1: nothing to misread on paper
/** 20 random bytes (160 bits) shown as PTV1-XXXX-… in an alphabet with no look-alike characters. */
export function newRecoveryKey(): { bytes: Uint8Array; text: string } {
  const bytes = random(20);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } value &= (1 << bits) - 1; }
  return { bytes, text: `PTV1-${out.match(/.{4}/g)!.join('-')}` };
}
export function parseRecoveryKey(text: string): Uint8Array | null {
  const s = text.toUpperCase().trim().replace(/^PTV1/, '').replace(/[\s-]/g, '');
  if (s.length !== 32) return null;
  const out = new Uint8Array(20);
  let bits = 0, value = 0, o = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch); if (v < 0) return null;
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out[o++] = (value >>> (bits - 8)) & 255; bits -= 8; value &= (1 << bits) - 1; }
  }
  return out;
}
export const RECOVERY_PARAMS = 'argon2id;m=19456;t=2;p=1';
export async function recoveryKek(bytes: Uint8Array, salt: Uint8Array, params = RECOVERY_PARAMS): Promise<Uint8Array> {
  const m = Number(params.match(/m=(\d+)/)?.[1] ?? 19456), t = Number(params.match(/t=(\d+)/)?.[1] ?? 2), p = Number(params.match(/p=(\d+)/)?.[1] ?? 1);
  if (m < 8192 || t < 1 || p < 1 || m > 1048576) throw new VaultCryptoError('Unexpected recovery parameters.');
  return argon2idAsync(bytes, salt, { m, t, p, dkLen: 32, asyncTick: 20 });
}
export const prfKek = (prfOutput: Uint8Array, salt: Uint8Array) => hkdf(sha256, prfOutput, salt, utf8('pt-vault/prf-kek/v1'), 32);

// ------------------------------------------------------------------ device linking: an eight-digit code both screens show

export function linkCode(x25519Public: string, mlKemPublic: string): string {
  const h = sha256(concat(utf8('pt-vault/link/v1'), unb64(x25519Public), unb64(mlKemPublic)));
  const n = ((h[0] << 24) >>> 0) + (h[1] << 16) + (h[2] << 8) + h[3];
  const s = String(n % 100000000).padStart(8, '0');
  return `${s.slice(0, 4)} ${s.slice(4)}`;
}
export function ephemeralKeys() {
  const xPriv = x25519.utils.randomSecretKey();
  const kem = ml_kem768.keygen();
  return { xPriv, kemSec: kem.secretKey, x25519Public: b64(x25519.getPublicKey(xPriv)), mlKemPublic: b64(kem.publicKey) };
}

// ------------------------------------------------------------------ one-time codes, computed here for sealed items (RFC 6238)

export function totpNow(secret: string, at = Date.now()): { code: string; left: number; period: number } | null {
  let key: Uint8Array | null = null, digits = 6, period = 30, alg: 'sha1' | 'sha256' | 'sha512' = 'sha1';
  const t = secret.trim();
  const base32 = (s: string) => {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', c = s.toUpperCase().replace(/[\s=-]/g, '');
    if (!c || [...c].some((ch) => !A.includes(ch))) return null;
    const out: number[] = []; let bits = 0, value = 0;
    for (const ch of c) { value = (value << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; value &= (1 << bits) - 1; } }
    return Uint8Array.from(out);
  };
  if (/^otpauth:\/\/totp\//i.test(t)) {
    const u = new URL(t);
    key = base32(u.searchParams.get('secret') ?? '');
    digits = [6, 7, 8].includes(Number(u.searchParams.get('digits'))) ? Number(u.searchParams.get('digits')) : 6;
    const p = Number(u.searchParams.get('period')); if (p >= 15 && p <= 120) period = p;
    const a = (u.searchParams.get('algorithm') ?? '').toUpperCase(); alg = a === 'SHA256' ? 'sha256' : a === 'SHA512' ? 'sha512' : 'sha1';
  } else key = base32(t);
  if (!key || key.length < 10) return null;
  const secs = Math.floor(at / 1000), counter = Math.floor(secs / period);
  const msg = new Uint8Array(8); let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = hmac(alg === 'sha256' ? sha256 : alg === 'sha512' ? sha512 : sha1, key, msg);
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return { code: String(bin % 10 ** digits).padStart(digits, '0'), left: period - (secs % period), period };
}

// ------------------------------------------------------------------ breach check by hash prefix (the password stays here)

export function breachParts(password: string) {
  const hex = Array.from(sha1(utf8(password)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { prefix: hex.slice(0, 5), suffix: hex.slice(5) };
}
export function breachCount(rangeBody: string, suffix: string): number {
  for (const line of rangeBody.split('\n')) { const [s, n] = line.trim().split(':'); if (s?.toUpperCase() === suffix) return Number(n) || 0; }
  return 0;
}
