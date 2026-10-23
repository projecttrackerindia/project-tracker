import { b64url, random, unb64 } from './crypto';

/**
 * Passkeys as vault keys (the WebAuthn "PRF" extension): the authenticator — a phone, Windows Hello, Touch ID, a security key — turns a
 * salt into a secret only it can make, after the person's fingerprint, face or PIN. That secret unlocks the vault; it never leaves this page
 * and the server never sees it, so a stolen password or database cannot open a sealed vault.
 */
export const prfSupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.create;

type PrfResults = { results?: { first?: ArrayBuffer }; enabled?: boolean };
const prfOf = (cred: PublicKeyCredential) => (cred.getClientExtensionResults() as { prf?: PrfResults }).prf;

/** Makes a passkey just for the vault and returns its id and the PRF output for `salt` (a second prompt only if the first did not give it). */
export async function createVaultPasskey(user: { id: string; email: string; name: string }, salt: Uint8Array, label: string): Promise<{ credentialId: string; prf: Uint8Array }> {
  if (!prfSupported()) throw new PasskeyError('This browser cannot use passkeys.');
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: random(32),
      rp: { id: location.hostname, name: 'ProjectTracker Vault' },
      user: { id: new TextEncoder().encode(`vault:${user.id}`), name: user.email, displayName: `${user.name} — ${label}` },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { type: 'public-key', alg: -8 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: new Uint8Array(salt) } } } as AuthenticationExtensionsClientInputs,
      timeout: 120_000,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyError('No passkey was made.');
  const credentialId = b64url(new Uint8Array(cred.rawId));
  const prf = prfOf(cred);
  if (prf?.results?.first) return { credentialId, prf: new Uint8Array(prf.results.first) };
  if (prf?.enabled === false) throw new PasskeyError('This passkey cannot unlock a vault (no PRF support). Use another device or the recovery key.');
  const out = await evaluate([{ credentialId, salt }]);
  return { credentialId, prf: out.prf };
}

/** Asks for one of these passkeys and returns which one answered and its PRF output for that passkey's salt. */
export async function evaluate(options: { credentialId: string; salt: Uint8Array }[]): Promise<{ credentialId: string; prf: Uint8Array }> {
  if (!prfSupported()) throw new PasskeyError('This browser cannot use passkeys.');
  const evalByCredential: Record<string, { first: Uint8Array<ArrayBuffer> }> = {};
  for (const o of options) evalByCredential[o.credentialId] = { first: new Uint8Array(o.salt) };
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: random(32), rpId: location.hostname, userVerification: 'required', timeout: 120_000,
      allowCredentials: options.map((o) => ({ type: 'public-key' as const, id: unb64(o.credentialId) })),
      extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new PasskeyError('No passkey answered.');
  const first = prfOf(cred)?.results?.first;
  if (!first) throw new PasskeyError('That passkey did not give a vault key (no PRF support). Use the recovery key.');
  return { credentialId: b64url(new Uint8Array(cred.rawId)), prf: new Uint8Array(first) };
}

export class PasskeyError extends Error {}
