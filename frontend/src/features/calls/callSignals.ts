import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RoomEvent, type DataPacket_Kind, type RemoteParticipant } from 'livekit-client';
import { useIsSpeaking, useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { toast } from '../../stores/ui';

/**
 * Raised hands and reactions in one of our calls. They travel as small messages over the call itself: the media server stamps each with
 * who really sent it, so nobody can raise a hand or react as someone else, and nobody needs the right to change their own name in the call
 * (which would let them put words in someone else's mouth in the agent's notes).
 *
 * - A hand stays up until its owner lowers it, speaks for a moment (as in Meet), or the host lowers it. Someone who joins later is told
 *   about hands already up by their owners.
 * - Reactions float up the side of the call for a few seconds; a quick burst from one person is thinned out.
 */
export const HAND_TOPIC = 'pt.hand';
export const REACT_TOPIC = 'pt.react';
export const REACTIONS = ['💖', '👍', '🎉', '👏', '😂', '😮', '😢', '🤔', '👎'] as const;
const LIFETIME = 4200;
const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Reaction { id: number; identity: string; name: string; emoji: string; lane: number }
export interface Hand { identity: string; name: string; at: number; mine: boolean }

export function useCallSignals(hostIdentity: string | null) {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const me = localParticipant.identity;
  const isHost = !!hostIdentity && me === hostIdentity;
  const [raised, setRaised] = useState<Map<string, number>>(new Map());
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const mineAt = useRef<number | null>(null);
  const seq = useRef(0);
  const lastSent = useRef(0);
  const recent = useRef(new Map<string, number[]>());

  const put = useCallback((identity: string, at: number | null) => setRaised((m) => {
    if (at === null ? !m.has(identity) : m.get(identity) === at) return m;
    const n = new Map(m); if (at === null) n.delete(identity); else n.set(identity, at); return n;
  }), []);

  const show = useCallback((identity: string, name: string, emoji: string) => {
    const id = ++seq.current;
    setReactions((r) => [...r.slice(-29), { id, identity, name, emoji, lane: Math.floor(Math.random() * 5) }]);
    window.setTimeout(() => setReactions((r) => r.filter((x) => x.id !== id)), LIFETIME);
  }, []);

  const handRef = useRef<(b: unknown, to?: string[]) => void>(() => {});
  const lowerMine = useCallback((why?: string) => {
    if (mineAt.current === null) return;
    mineAt.current = null; put(me, null); handRef.current({ raised: false });
    if (why) toast(why, 'info');
  }, [me, put]);

  handRef.current = (b, to) => {
    void localParticipant.publishData(enc.encode(JSON.stringify(b)), { reliable: true, topic: HAND_TOPIC, ...(to ? { destinationIdentities: to } : {}) })
      .catch((e: unknown) => console.warn('A raised hand could not be sent', e));
  };

  // What the others send. The sender is the one the media server says it is.
  const onHand = useRef<(from: RemoteParticipant, payload: Uint8Array) => void>(() => {});
  onHand.current = (from, payload) => {
    let body: { raised?: boolean; at?: number; lower?: string; lowerAll?: boolean };
    try { body = JSON.parse(dec.decode(payload)); } catch { return; }
    if (body.lowerAll || body.lower) {
      if (from.identity !== hostIdentity) return;   // only the host lowers other people's hands
      if (body.lowerAll || body.lower === me) lowerMine(`${from.name || 'The host'} lowered your hand`);
      return;
    }
    put(from.identity, body.raised ? Math.min(Number(body.at) || Date.now(), Date.now()) : null);
  };
  const onReact = useRef<(from: RemoteParticipant, payload: Uint8Array) => void>(() => {});
  onReact.current = (from, payload) => {
    const emoji = dec.decode(payload);
    if (!(REACTIONS as readonly string[]).includes(emoji)) return;
    const now = Date.now(), times = (recent.current.get(from.identity) ?? []).filter((t) => now - t < 2000);
    if (times.length >= 6) return;   // a burst from one person: show a few, not a wall
    recent.current.set(from.identity, [...times, now]);
    show(from.identity, from.name || from.identity, emoji);
  };
  useEffect(() => {
    const got = (payload: Uint8Array, from?: RemoteParticipant, _kind?: DataPacket_Kind, topic?: string) => {
      if (!from) return;
      if (topic === HAND_TOPIC) onHand.current(from, payload);
      else if (topic === REACT_TOPIC) onReact.current(from, payload);
    };
    room.on(RoomEvent.DataReceived, got);
    return () => { room.off(RoomEvent.DataReceived, got); };
  }, [room]);

  const raise = useCallback(() => {
    const at = Date.now();
    mineAt.current = at; put(me, at); handRef.current({ raised: true, at });
  }, [me, put]);
  const lowerAll = useCallback(() => {
    if (!isHost) return;
    handRef.current({ lowerAll: true }); lowerMine();
    setRaised(new Map());
  }, [isHost, lowerMine]);
  const lowerOne = useCallback((identity: string) => {
    if (!isHost) return;
    if (identity === me) { lowerMine(); return; }
    handRef.current({ lower: identity }, [identity]);
  }, [isHost, me, lowerMine]);
  const sendReaction = useCallback((emoji: string) => {
    const now = Date.now();
    if (now - lastSent.current < 250) return;
    lastSent.current = now;
    show(me, 'You', emoji);
    void localParticipant.publishData(enc.encode(emoji), { reliable: false, topic: REACT_TOPIC }).catch((e: unknown) => console.warn('A reaction could not be sent', e));
  }, [me, localParticipant, show]);

  // Someone who joins later learns about hands already up, from their owners; someone who leaves takes their hand down.
  useEffect(() => {
    const timers: number[] = [];
    const joined = (p: RemoteParticipant) => {
      timers.push(window.setTimeout(() => { if (mineAt.current !== null) handRef.current({ raised: true, at: mineAt.current }, [p.identity]); }, 1500));
    };
    const left = (p: RemoteParticipant) => put(p.identity, null);
    room.on(RoomEvent.ParticipantConnected, joined).on(RoomEvent.ParticipantDisconnected, left);
    return () => { room.off(RoomEvent.ParticipantConnected, joined).off(RoomEvent.ParticipantDisconnected, left); timers.forEach((t) => window.clearTimeout(t)); };
  }, [room, put]);

  // As in Meet: speaking for a moment with your hand up lowers it.
  const speaking = useIsSpeaking(localParticipant);
  useEffect(() => {
    if (!speaking || mineAt.current === null) return;
    const t = window.setTimeout(() => lowerMine('Your hand was lowered because you spoke'), 2500);
    return () => window.clearTimeout(t);
  }, [speaking, lowerMine]);

  const hands: Hand[] = useMemo(() => [...raised.entries()].sort((a, b) => a[1] - b[1]).map(([identity, at]) => ({
    identity, at, mine: identity === me,
    name: identity === me ? 'You' : room.getParticipantByIdentity(identity)?.name || 'Someone',
  })), [raised, me, room]);

  return { hands, handUp: raised.has(me), raise, lower: () => lowerMine(), lowerAll, lowerOne, isHost, reactions, sendReaction };
}

export type CallSignals = ReturnType<typeof useCallSignals>;
