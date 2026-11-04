/** LiveKit's end-to-end encryption for private calls (insertable streams in a worker). Loaded only when a private call is joined. */
import { ExternalE2EEKeyProvider, Room, type RoomOptions } from 'livekit-client';

export const e2eeSupported = () => typeof window !== 'undefined' && typeof Worker !== 'undefined'
  && (typeof (window as unknown as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform !== 'undefined'
    || typeof (RTCRtpSender.prototype as unknown as { createEncodedStreams?: unknown }).createEncodedStreams === 'function');

/** A LiveKit room with end-to-end encryption on, ready to be passed to <LiveKitRoom room={…} />. */
export async function encryptedRoom(roomKey: string, base: RoomOptions): Promise<Room> {
  if (!e2eeSupported()) throw new Error('This browser cannot join end-to-end encrypted calls. Try a recent Chrome, Edge, Firefox or Safari.');
  const keyProvider = new ExternalE2EEKeyProvider();
  const worker = new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });
  const room = new Room({ ...base, e2ee: { keyProvider, worker } });
  await keyProvider.setKey(roomKey);
  await room.setE2EEEnabled(true);
  return room;
}
