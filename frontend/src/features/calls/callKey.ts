/**
 * Private calls: the room key, which the server never sees (no LiveKit code here, so the chat screen stays light).
 * The caller makes the key, encrypts it for every invited person's devices with the private-chat crypto (chat/e2e), and the server only
 * passes the envelope along. Each joiner opens it on their device and hands the key to LiveKit.
 */
import { newRoomKey, open, seal } from '../chat/e2e/crypto';
import { deviceIdentity, e2eApi } from '../chat/e2e/session';

export const CALL_KEY_CONTEXT = 'pt-call-key';

/** A new room key, encrypted for these people's devices (the caller's own included, so they can rejoin). */
export async function sealRoomKey(people: string[], conversationId?: string | null): Promise<string> {
  const me = await deviceIdentity();
  if (!me) throw new Error('Set up private chat on this device first: private calls use the same keys.');
  const keys = conversationId ? await e2eApi.conversationKeys(conversationId) : await e2eApi.peopleKeys(people);
  return seal(newRoomKey(), me, keys, CALL_KEY_CONTEXT);
}

export async function openRoomKey(keyCipher: string): Promise<string> {
  const me = await deviceIdentity();
  if (!me) throw new Error('This is a private call. Set up (or restore) private chat on this device to join it.');
  const r = await open(keyCipher, me, CALL_KEY_CONTEXT);
  if (!r.ok) throw new Error(r.reason === 'not-for-this-device' ? 'The call key was not shared with this device. Ask the host to share it again.' : 'The call key could not be opened.');
  return r.text;
}

