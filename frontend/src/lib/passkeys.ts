import type { PasskeyOptions } from '../api/types';

/** Passkeys are the browser's own WebAuthn: it needs a secure page (https or localhost) and a browser that has it. */
export const passkeysSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window && !!navigator.credentials;

const toBuffer = (b64url: string): ArrayBuffer => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
};
const toText = (buf: ArrayBuffer | null): string | null => {
  if (!buf) return null;
  let s = ''; new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

type Descriptor = { id: string; type: PublicKeyCredentialType; transports?: AuthenticatorTransport[] };
const descriptors = (list?: Descriptor[]) => (list ?? []).map((d) => ({ ...d, id: toBuffer(d.id) }));

/** The device creates a new key pair (fingerprint, face or screen lock) and returns what the server needs to remember its public half. */
export async function createPasskey(o: PasskeyOptions): Promise<Record<string, unknown>> {
  const publicKey = { ...o, challenge: toBuffer(o.challenge), user: { ...o.user!, id: toBuffer(o.user!.id) }, excludeCredentials: descriptors(o.excludeCredentials) } as unknown as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No passkey was created.', 'NotAllowedError');
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id, rawId: toText(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    response: { attestationObject: toText(r.attestationObject), clientDataJSON: toText(r.clientDataJSON), transports: r.getTransports?.() ?? [] },
  };
}

/** The device signs the server's challenge with a key it already holds for this site. */
export async function requestPasskey(o: PasskeyOptions): Promise<Record<string, unknown>> {
  const publicKey = { ...o, challenge: toBuffer(o.challenge), allowCredentials: descriptors(o.allowCredentials) } as unknown as PublicKeyCredentialRequestOptions;
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new DOMException('No passkey was used.', 'NotAllowedError');
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id, rawId: toText(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    response: { authenticatorData: toText(r.authenticatorData), clientDataJSON: toText(r.clientDataJSON), signature: toText(r.signature), userHandle: toText(r.userHandle) },
  };
}

/** True when the person closed or refused the device's prompt: not an error worth shouting about. */
export const wasCancelled = (e: unknown) => e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'AbortError');
