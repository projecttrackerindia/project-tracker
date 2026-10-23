import { useEffect, useRef, useState } from 'react';
import { get, uploadFile } from '../../api/client';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { audioSupported, startRecording, unlockAudio, type Recording } from '../work/voiceAudio';

interface SpeechStatus { available: boolean; maxSeconds: number }
interface Transcript { text: string; language: string | null }
const LANG: Record<string, string> = { hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali', gu: 'Gujarati', pa: 'Punjabi', od: 'Odia' };

/**
 * The microphone in the ask box. Tap and speak (English, Hindi, Telugu or another Indian language); it stops by itself when you pause,
 * or tap again. The words go into the box for you to read and send, so a mishearing is never acted on. Nothing is recorded or kept.
 */
export function VoiceInput({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const status = useWsQuery(['ai', 'speech'], () => get<SpeechStatus>('/ai/speech'), { staleTime: 600_000, retry: false });
  const [state, setState] = useState<'idle' | 'listening' | 'reading'>('idle');
  const rec = useRef<Recording | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);

  const release = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  useEffect(() => () => { rec.current?.cancel(); release(); }, []);

  const finish = async () => {
    const r = rec.current; rec.current = null;
    if (!r) return;
    const heard = r.heardSpeech();
    const wav = r.stop();
    release();
    if (!heard) { setState('idle'); toast('Nothing was heard. Tap the microphone and speak.', 'info'); return; }
    setState('reading');
    try {
      const t = await uploadFile<Transcript>('/ai/speech', new File([wav], 'speech.wav', { type: 'audio/wav' }));
      onText(t.text);
      if (t.language && LANG[t.language]) toast(`Heard in ${LANG[t.language]}. Check the words, then send.`, 'info');
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not understand that. Try again.', 'error'); }
    finally { setState('idle'); }
  };

  const start = async () => {
    unlockAudio();   // on the tap itself, before any await (phones require it)
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      rec.current = await startRecording(stream.current, { pauseMs: 1300, onTurnEnd: () => void finish() });
      setState('listening');
      timer.current = window.setTimeout(() => void finish(), (status.data?.maxSeconds ?? 60) * 1000);
    } catch {
      release();
      toast('The microphone is blocked. Allow it for this site in the browser, then try again.', 'error');
    }
  };

  if (!status.data?.available || !audioSupported()) return null;
  const listening = state === 'listening';
  return (
    <button type="button" className={`ai-mic ${state}`} data-testid="ai-mic" disabled={disabled || state === 'reading'} aria-pressed={listening}
      aria-label={listening ? 'Stop and use what I said' : 'Speak instead of typing'} title={listening ? 'Listening… tap to stop' : 'Speak (English, Hindi, Telugu and more)'}
      onClick={() => (listening ? void finish() : void start())}
      onKeyDown={(e) => { if (e.key === 'Escape' && listening) { rec.current?.cancel(); rec.current = null; release(); setState('idle'); } }}>
      {state === 'reading' ? <span className="spinner" /> : <Icon name="mic" size={17} />}
      {listening && <span className="ai-mic-wave" aria-hidden="true"><i /><i /><i /></span>}
    </button>
  );
}
