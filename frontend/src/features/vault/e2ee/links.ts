/**
 * Self-destructing links. The secret is encrypted here (AES-256-GCM) with a key made from 32 random bytes that travel only in the link's
 * #fragment — browsers never send a fragment to any server — and, when the sender adds one, a passphrase told separately (Argon2id). The
 * server gets ciphertext and the SHA-256 of the link's token, hands the ciphertext out the allowed number of times, then destroys it.
 *
 * Kept apart from the rest of the vault's cryptography so the page that opens a link loads only what it needs.
 */
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface LinkField { label: string; value: string; secret: boolean }
export interface LinkPayload { v: 1; title: string; fields: LinkField[] }

const te = new TextEncoder(), td = new TextDecoder();
export const LINK_PARAMS = 'argon2id;m=19456;t=2;p=1';
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const b64url = (u: Uint8Array) => { let s = ''; u.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const b64 = (u: Uint8Array) => { let s = ''; u.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The server keeps only this: SHA-256 of the token in the link's path (hex). */
export const tokenHash = (token: string) => bytesToHex(sha256(te.encode(token)));
const aad = (token: string) => te.encode(`secret-link/v1|${tokenHash(token)}`);

async function linkKey(fragment: Uint8Array, passphrase: string | null, salt: Uint8Array | null, params: string | null): Promise<CryptoKey> {
  let ikm: Uint8Array = fragment;
  if (passphrase) {
    const m = Number(params?.match(/m=(\d+)/)?.[1] ?? 19456), t = Number(params?.match(/t=(\d+)/)?.[1] ?? 2), p = Number(params?.match(/p=(\d+)/)?.[1] ?? 1);
    const stretched = await argon2idAsync(te.encode(passphrase.normalize('NFKC')), salt!, { m, t, p, dkLen: 32 });
    ikm = new Uint8Array([...fragment, ...stretched]);
    stretched.fill(0);
  }
  const raw = hkdf(sha256, ikm, undefined, te.encode('pt-vault/secret-link/v1'), 32);
  if (ikm !== fragment) ikm.fill(0);
  try { return await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']); } finally { raw.fill(0); }
}

/** Encrypts a secret for a new link. Returns what the server stores, and the link (token in the path, key in the fragment). */
export async function sealLink(payload: LinkPayload, passphrase: string | null, origin = location.origin) {
  const token = b64url(rand(32));
  const fragment = rand(32);
  const salt = passphrase ? rand(16) : null;
  const key = await linkKey(fragment, passphrase, salt, LINK_PARAMS);
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(token) }, key, te.encode(JSON.stringify(payload))));
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1; out.set(iv, 1); out.set(ct, 13);
  const url = `${origin}/s/${token}#${b64url(fragment)}`;
  fragment.fill(0);
  return { url, token, body: { tokenHash: tokenHash(token), cipher: b64(out), hasPassphrase: !!passphrase, salt: salt ? b64(salt) : null, params: passphrase ? LINK_PARAMS : null } };
}

export class LinkKeyError extends Error {}

/** Opens what the server handed out, with the key from the fragment (and the passphrase, when the link has one). */
export async function openLink(token: string, fragmentText: string, cipher: string, passphrase: string | null, salt: string | null, params: string | null): Promise<LinkPayload> {
  let fragment: Uint8Array;
  try { fragment = unb64url(fragmentText); } catch { throw new LinkKeyError('The link is incomplete: copy all of it, including the part after #.'); }
  if (fragment.length !== 32) throw new LinkKeyError('The link is incomplete: copy all of it, including the part after #.');
  const data = unb64(cipher);
  if (data[0] !== 1 || data.length < 13 + 16) throw new LinkKeyError('The secret is damaged.');
  const key = await linkKey(fragment, passphrase, salt ? unb64(salt) : null, params);
  fragment.fill(0);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(1, 13), additionalData: aad(token) }, key, data.subarray(13));
    const p = JSON.parse(td.decode(plain)) as LinkPayload;
    if (p.v !== 1 || !Array.isArray(p.fields)) throw new LinkKeyError('The secret is damaged.');
    return p;
  } catch (e) {
    if (e instanceof LinkKeyError) throw e;
    throw new LinkKeyError(passphrase !== null ? 'That passphrase does not open it. Check it with the sender and try again.' : 'The link is incomplete or damaged: copy all of it, including the part after #.');
  }
}
