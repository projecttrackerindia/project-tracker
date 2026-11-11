import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { recordingApi, type RecordingLine, type RecordingMinutes } from '../../api/endpoints';

export type RecordSource = 'tab' | 'desktop' | 'mic';
export type RecordPhase = 'ready' | 'recording' | 'finishing' | 'done';
const PIECE_MS = 25_000;
const MIN_BYTES = 2_000;

const mime = () => ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));

/** Records one stream as separate short, independently playable pieces (a new recorder per piece), handing each to `onPiece`. */
function pieces(stream: MediaStream, onPiece: (blob: Blob, offsetSeconds: number) => void) {
  let stopped = false; let rec: MediaRecorder | null = null; let timer = 0; const began = Date.now();
  const next = () => {
    if (stopped) return;
    const at = (Date.now() - began) / 1000;
    const chunks: Blob[] = [];
    rec = new MediaRecorder(stream, { mimeType: mime() });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec?.mimeType || 'audio/webm' });
      if (blob.size >= MIN_BYTES) onPiece(blob, at);
      next();
    };
    rec.start();
    timer = window.setTimeout(() => { if (rec?.state === 'recording') rec.stop(); }, PIECE_MS);
  };
  next();
  return () => { stopped = true; window.clearTimeout(timer); if (rec?.state === 'recording') rec.stop(); };
}

const message = (e: unknown, fallback: string) => e instanceof ApiError ? e.errors[0]?.message ?? e.message : e instanceof Error && e.message ? e.message : fallback;

/** Records the meeting from this device and keeps the words as they are written down. */
export function useRecorder(meetingId: string) {
  const [phase, setPhase] = useState<RecordPhase>('ready');
  const [lines, setLines] = useState<RecordingLine[]>([]);
  const [secs, setSecs] = useState(0);
  const [minutes, setMinutes] = useState<RecordingMinutes>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useRef<string | null>(null);
  const stops = useRef<(() => void)[]>([]);
  const streams = useRef<MediaStream[]>([]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const release = useCallback(() => { stops.current.forEach((f) => f()); stops.current = []; streams.current.forEach((s) => s.getTracks().forEach((t) => t.stop())); streams.current = []; }, []);
  useEffect(() => release, [release]);
  useEffect(() => {
    if (phase !== 'recording') return;
    const t = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [phase]);

  const send = (blob: Blob, who: 'me' | 'others', offset: number) => {
    // One piece at a time, in order, so the transcript reads in the order it was said.
    queue.current = queue.current.then(async () => {
      try {
        const line = id.current ? await recordingApi.segment(id.current, blob, who, offset) : null;
        if (line) setLines((l) => [...l, line]);
      } catch (e) { setError(message(e, 'A piece of the recording could not be written down.')); }
    });
  };

  const start = async (source: RecordSource) => {
    setError(null);
    try {
      const audio = (s: MediaStream) => new MediaStream(s.getAudioTracks());
      const parts: { stream: MediaStream; who: 'me' | 'others' }[] = [];
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      streams.current.push(mic); parts.push({ stream: audio(mic), who: 'me' });
      if (source !== 'mic') {
        const shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        streams.current.push(shared);
        if (shared.getAudioTracks().length === 0) throw new Error('No sound was shared. Choose the meeting tab and tick “Share tab audio”.');
        shared.getVideoTracks().forEach((t) => t.stop()); // only the sound is used
        parts.push({ stream: audio(shared), who: 'others' });
        shared.getAudioTracks()[0].addEventListener('ended', () => void stop());
      }
      const rec = await recordingApi.start(meetingId);
      id.current = rec.id; setLines([]); setSecs(0); setMinutes(null);
      stops.current = parts.map((p) => pieces(p.stream, (blob, at) => send(blob, p.who, at)));
      setPhase('recording');
    } catch (e) {
      release();
      setError(e instanceof DOMException && e.name === 'NotAllowedError' ? 'Recording needs permission for the microphone and the shared sound.' : message(e, 'Recording could not start.'));
    }
  };

  const stop = async () => {
    if (!id.current) return;
    setPhase('finishing');
    release();
    // The last pieces are written down before the minutes are asked for.
    await new Promise((r) => setTimeout(r, 400));
    await queue.current;
    try { setMinutes(await recordingApi.finish(id.current)); setPhase('done'); }
    catch (e) { setError(message(e, 'The minutes could not be written. The words are kept.')); setPhase('done'); }
  };

  const reset = () => { setPhase('ready'); setLines([]); setMinutes(null); setError(null); setSecs(0); id.current = null; };
  return { phase, lines, secs, minutes, error, start, stop, reset, recordingId: () => id.current };
}
