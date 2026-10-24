/**
 * The notetaker's voice. When a meeting asked for "transcription + voice suggestions", the API sends short lines to say out loud (for
 * example "Before we wrap up: nobody has covered the release date yet."), each with its voice already made (a WAV file). The bot plays it
 * into the call: in our own calls as its own microphone track, in Google Meet and Teams through a microphone the page is given, unmuted only
 * while it speaks.
 */

/** Reads a 16-bit PCM WAV file: its rate, channels and samples (mono: other channels are dropped). Null when it is not one. */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12; let rate = 0; let channels = 0; let bits = 0; let format = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body); channels = buf.readUInt16LE(body + 2); rate = buf.readUInt32LE(body + 4); bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || !rate || !channels) return null;
      const end = Math.min(buf.length, body + size);
      const frames = Math.floor((end - body) / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) pcm[i] = buf.readInt16LE(body + i * 2 * channels);
      return { rate, channels: 1, pcm };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** How long a line takes to say, in milliseconds. */
export const durationMs = (wav) => Math.round((wav.pcm.length / wav.rate) * 1000);

/** The lines the API sent, checked: words to post and a WAV to play (at most four at once, each under ~2 MB). */
export function sayItems(list) {
  return (Array.isArray(list) ? list.slice(0, 20) : [])
    .map((s) => ({ text: String(s?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), audio: typeof s?.audio === 'string' && s.audio.length <= 3_000_000 ? s.audio : null }))
    .filter((s) => s.text && s.audio).slice(0, 4);
}

/**
 * Runs in the Meet or Teams page before it loads: whatever microphone the page asks for is a line from a sound mixer, silent until the bot
 * plays a voice into it with window.ptSay(base64 WAV), which resolves once it has been said. Camera requests still get the real (fake)
 * camera, which the bot switches off.
 */
export const VOICE_HOOK = `(() => {
  if (window.__ptVoice) return; window.__ptVoice = true;
  const md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;
  const native = md.getUserMedia.bind(md);
  let ctx, dest;
  const line = () => {
    if (!ctx) { ctx = new AudioContext(); dest = ctx.createMediaStreamDestination(); }
    if (ctx.state === 'suspended') ctx.resume();
    return dest;
  };
  md.getUserMedia = async (constraints = {}) => {
    if (!constraints.audio) return native(constraints);
    const out = new MediaStream(line().stream.getAudioTracks().map((t) => t.clone()));
    if (constraints.video) { try { (await native({ video: constraints.video })).getVideoTracks().forEach((t) => out.addTrack(t)); } catch (e) { console.log('pt voice: ' + e); } }
    return out;
  };
  window.ptSay = async (b64) => {
    const d = line();
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const audio = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = audio; src.connect(d);
    await new Promise((resolve) => { src.onended = resolve; src.start(); });
    return audio.duration;
  };
})();`;
