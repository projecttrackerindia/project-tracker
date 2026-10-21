/**
 * Microphone and speaker for the spoken test call.
 *
 * Phones (iPhone Safari above all) only allow sound that a tap started, and their MediaRecorder writes formats speech services often
 * refuse. So one AudioContext is created on the user's tap and used for both directions: the microphone is recorded as plain 16 kHz
 * mono WAV (what Sarvam handles best, the same on every device), and the agent's replies are played through it without being blocked.
 */
const RATE = 16_000;

let ctx: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;

/** Call from a tap or click handler, before any await: creates or wakes the audio engine. */
export function unlockAudio(): AudioContext | null {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export const audioSupported = () =>
  typeof window !== 'undefined' && !!(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) && !!navigator.mediaDevices?.getUserMedia;

export function stopPlayback() {
  try { playing?.stop(); } catch { /* already stopped */ }
  playing = null;
}

/** Plays a base64 WAV and resolves when it ends (or at once when it cannot be played; the text is on screen anyway). */
export async function playWav(base64: string | null | undefined): Promise<void> {
  if (!base64 || !ctx) return;
  stopPlayback();
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    playing = src;
    await new Promise<void>((done) => { src.onended = () => done(); src.start(); });
  } catch { /* undecodable audio: the reply is still shown as text */ }
  finally { playing = null; }
}

export interface Recording { stop: () => Blob; cancel: () => void }

/** Starts recording the microphone. stop() returns the speech as a 16 kHz mono WAV. */
export async function startRecording(stream: MediaStream): Promise<Recording> {
  const c = unlockAudio();
  if (!c) throw new Error('No audio support');
  const source = c.createMediaStreamSource(stream);
  // ScriptProcessor is old but is the one recorder that works the same on iPhone, Android and desktop browsers.
  const node = c.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  node.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  const mute = c.createGain(); mute.gain.value = 0;   // keeps the node running without echoing the caller back
  source.connect(node); node.connect(mute); mute.connect(c.destination);
  const close = () => { node.onaudioprocess = null; try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* gone */ } };
  return {
    cancel: close,
    stop: () => { close(); return toWav(chunks, c.sampleRate); },
  };
}

function toWav(chunks: Float32Array[], fromRate: number): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { input.set(c, o); o += c.length; }
  // Average down to 16 kHz (simple box filter: good enough for speech).
  const ratio = fromRate / RATE;
  const length = Math.floor(input.length / ratio);
  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, end > start ? sum / (end - start) : 0));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buf);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

/** Seconds of speech in a WAV made by toWav. */
export const wavSeconds = (b: Blob) => Math.max(0, (b.size - 44) / (RATE * 2));
