import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Records the call's audio and transcribes it with Whisper after the call (far more accurate than live captions, and it understands mixed
 * Hindi/Telugu/English). The page's WebRTC audio tracks are mixed in the browser and recorded as Opus/WebM; speakers' names come from the
 * live captions, matched by time.
 */

/** Runs in the page before Meet/Teams load: every incoming audio track is mixed into one recording, sent to the bot in 10-second chunks. */
export const AUDIO_HOOK = `(() => {
  if (window.__ptAudio) return; window.__ptAudio = true;
  let ctx, dest, rec;
  const start = () => {
    if (rec) return;
    try {
      rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
      rec.ondataavailable = async (e) => {
        if (!e.data || !e.data.size || !window.ptAudio) return;
        const buf = new Uint8Array(await e.data.arrayBuffer()); let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        window.ptAudio(btoa(s));
      };
      rec.start(10000);
      window.ptAudioStart && window.ptAudioStart(Date.now());
    } catch (err) { console.log('pt audio: ' + err); }
  };
  const add = (track) => {
    try {
      if (!ctx) { ctx = new AudioContext(); dest = ctx.createMediaStreamDestination(); }
      if (ctx.state === 'suspended') ctx.resume();
      ctx.createMediaStreamSource(new MediaStream([track])).connect(dest);
      start();
    } catch (err) { console.log('pt audio: ' + err); }
  };
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  window.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    pc.addEventListener('track', (e) => { if (e.track && e.track.kind === 'audio') add(e.track); });
    return pc;
  };
  window.RTCPeerConnection.prototype = Native.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, Native);
  window.ptStopAudio = () => new Promise((resolve) => {
    if (!rec || rec.state === 'inactive') return resolve(false);
    rec.addEventListener('stop', () => setTimeout(() => resolve(true), 300), { once: true });
    rec.stop();
  });
})();`;

/** Collects the chunks into a file on disk (never kept in memory). */
export class AudioFile {
  constructor(id) { this.file = path.join(tmpdir(), `pt-call-${id}.webm`); this.stream = null; this.bytes = 0; this.startedAt = null; }
  write(b64) {
    this.stream ??= createWriteStream(this.file);
    const buf = Buffer.from(String(b64), 'base64');
    this.bytes += buf.length;
    this.stream.write(buf);
  }
  async close() { if (this.stream) await new Promise((r) => this.stream.end(r)); }
  async remove() { await rm(this.file, { force: true }).catch(() => undefined); }
}

let queue = Promise.resolve();
const here = path.dirname(fileURLToPath(import.meta.url));

/** Whisper (faster-whisper) on the recording, one call at a time per machine. Resolves to [{start, end, text}] or null when unavailable. */
export function transcribe(file, env = process.env, log = () => {}) {
  const model = env.MEETBOT_WHISPER_MODEL ?? 'small';
  if (model === 'off') return Promise.resolve(null);
  const run = () => new Promise((resolve) => {
    const args = [path.join(here, 'transcribe.py'), file, model, env.MEETBOT_WHISPER_LANGUAGE ?? ''];
    const p = spawn(env.MEETBOT_PYTHON ?? 'python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { log(`whisper unavailable: ${e.message}`); resolve(null); });
    p.on('close', (code) => {
      if (code !== 0) { log(`whisper failed (${code}): ${err.trim().split('\n').pop()}`); return resolve(null); }
      try { resolve(JSON.parse(out).segments ?? null); } catch { resolve(null); }
    });
  });
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Names each Whisper segment after whoever the live captions showed speaking at that moment (the caption speaker nearest in time, looking a
 * little back since captions trail the voice). Segments with no caption nearby keep the previous speaker.
 */
export function align(segments, captions, startedAt) {
  const marks = captions.map((c) => ({ name: c.name, t: Date.parse(c.at) })).filter((c) => Number.isFinite(c.t)).sort((a, b) => a.t - b.t);
  let last = 'Speaker';
  return segments.map((s) => {
    const mid = startedAt + ((s.start + s.end) / 2) * 1000;
    let best = null; let gap = Infinity;
    for (const m of marks) {
      const d = Math.abs(m.t - (mid + 1500));
      if (d < gap) { gap = d; best = m; }
      if (m.t > mid + 15000) break;
    }
    if (best && gap < 12000) last = best.name;
    return { name: last, text: String(s.text).trim(), at: new Date(startedAt + s.start * 1000).toISOString() };
  }).filter((l) => l.text);
}

export async function sizeOf(file) { try { return (await stat(file)).size; } catch { return 0; } }
