/**
 * A one-time, in-memory hand-off of a secret from another screen (e.g. Messages › "Send to Vault instead") to the new-item editor.
 * Deliberately not the clipboard, the address or history state: those can be read by other apps, logged, or restored later.
 */
let pending: { title: string; text: string } | null = null;
export function handToVault(title: string, text: string) { pending = { title, text }; }
/** Takes the waiting hand-off, once. */
export function takeVaultHandoff(): { title: string; text: string } | null { const p = pending; pending = null; return p; }
