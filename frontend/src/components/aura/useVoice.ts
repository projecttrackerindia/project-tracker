import { useCallback, useEffect, useRef, useState } from 'react';

/* The browser's speech recognition (Chrome, Edge, Safari): not in TypeScript's DOM types, so typed here as far as Aura uses it. */
interface SpeechAlt { transcript: string }
interface SpeechResult { isFinal: boolean; length: number; [i: number]: SpeechAlt }
interface SpeechEvent { resultIndex: number; results: { length: number; [i: number]: SpeechResult } }
interface Recognizer {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: SpeechEvent) => void) | null; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start: () => void; stop: () => void; abort: () => void;
}
type RecognizerCtor = new () => Recognizer;

const ctor = (): RecognizerCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};
/** Whether this browser can listen (the Web Speech API). Where it cannot, Aura falls back to typing. */
export const voiceSupported = () => ctor() !== null;

export type VoiceState = 'idle' | 'listening' | 'unsupported' | 'denied';

/**
 * Hold-to-talk for the Aura bar: `start` listens and shows the words as they are heard (`transcript`, with `beat` ticking on each new
 * word for the colour wave); `stop(true)` hands the words to `onDone`, `stop(false)` drops them. Where the API is missing or the
 * microphone is refused the state says so and nothing else happens: the person types instead.
 */
export function useVoice(onDone: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [beat, setBeat] = useState(0);
  const rec = useRef<Recognizer | null>(null);
  const text = useRef('');
  const send = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;

  const start = useCallback(() => {
    const C = ctor();
    if (!C) { setState('unsupported'); return false; }
    if (rec.current) return true;
    const r = new C();
    r.lang = navigator.language || 'en-IN';
    r.interimResults = true;
    r.continuous = true;
    text.current = ''; send.current = false; setTranscript('');
    r.onresult = (e) => {
      let s = '';
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0]?.transcript ?? '';
      text.current = s.trim();
      setTranscript(text.current);
      setBeat((b) => b + 1);
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { send.current = false; setState('denied'); } };
    r.onend = () => {
      rec.current = null;
      setState((s) => (s === 'listening' ? 'idle' : s));
      if (send.current && text.current) done.current(text.current);
      send.current = false;
    };
    try { r.start(); } catch { setState('unsupported'); return false; }
    rec.current = r;
    setState('listening');
    return true;
  }, []);

  const stop = useCallback((andSend: boolean) => {
    const r = rec.current; if (!r) return;
    send.current = andSend;
    try { if (andSend) r.stop(); else r.abort(); } catch { /* already ended */ }
  }, []);

  useEffect(() => () => { send.current = false; rec.current?.abort(); }, []);
  return { state, transcript, beat, start, stop, reset: () => setState('idle') };
}
