import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { align, transcribe } from './audio.mjs';
import { parseWav, sayItems } from './voice.mjs';

/**
 * The project agent in one of our own calls (a room on our LiveKit media server). Unlike Google Meet or Teams there is no browser and no
 * lobby: the API hands the worker a pass for the room in the agent's own name, so it is simply in the call. It hears every person on their
 * own audio track, so who said what is exact; each thing someone says (a pause ends it) goes to the API to be written down. If the API has
 * no speech service, the words are kept in one recording and transcribed with Whisper after the call. It reads and writes the call's chat
 * (the same "lk.chat" messages the call screen shows) and leaves when the call ends, when it is alone, or at its time limit.
 *
 * Statuses, as the worker reports them: scheduled → joining → in_call_recording → call_ended → done (or fatal).
 */

const RATE = 16_000;
const FRAME_MS = 20;
export const CHAT_TOPIC = 'lk.chat';

/** Cuts one person's audio into utterances: speech that a pause (or a length limit) ends. Pure, so it can be tested without a call. */
export class Segmenter {
  constructor({ pauseMs = 700, maxMs = 20_000, minMs = 400, onUtterance }) {
    this.pauseMs = pauseMs; this.maxMs = maxMs; this.minMs = minMs; this.onUtterance = onUtterance;
    this.floor = 0; this.frames = 0; this.speaking = false; this.quietMs = 0; this.chunks = []; this.ms = 0; this.startedAt = 0;
  }

  /** One frame of 16-bit mono PCM. */
  push(pcm, at = Date.now()) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    const ms = (pcm.length / RATE) * 1000;
    this.frames++;
    if (this.frames <= 10) { this.floor = Math.max(this.floor, rms); return; }   // the first 200 ms: the line's own background level
    const threshold = Math.max(0.01, this.floor * 2.5);
    if (!this.speaking) {
      this.floor = this.floor * 0.98 + Math.min(rms, threshold) * 0.02;
      if (rms > threshold) { this.speaking = true; this.startedAt = at; this.chunks = [pcm]; this.ms = ms; this.quietMs = 0; }
      return;
    }
    this.chunks.push(pcm); this.ms += ms;
    this.quietMs = rms < threshold * 0.7 ? this.quietMs + ms : 0;
    if (this.quietMs >= this.pauseMs || this.ms >= this.maxMs) this.end();
  }

  end() {
    if (!this.speaking) return;
    this.speaking = false;
    const spoken = this.ms - this.quietMs;
    const chunks = this.chunks; this.chunks = []; this.ms = 0; this.quietMs = 0;
    if (spoken < this.minMs) return;   // a cough or a click
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    this.onUtterance?.(pcm, this.startedAt);
  }
}

/** 16-bit mono PCM as a WAV file. */
export function wav(pcm, rate = RATE) {
  const buf = Buffer.alloc(44 + pcm.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, 44);
  return buf;
}

/** Whether a participant is the agent itself (or another agent): it is not listened to, and does not count as company. */
const isAgent = (p) => (p?.identity ?? '').startsWith('agent:');

export class LiveKitBot {
  constructor({ liveKitUrl, liveKitToken, botName, joinAt, leaveAt, webhookUrl, introMessage, agendaMessage, raiseMessage, readChat, voice }, deps) {
    this.id = randomUUID();
    this.kind = 'livekit';
    this.liveKitUrl = liveKitUrl;
    this.liveKitToken = liveKitToken;
    this.botName = botName;
    this.joinAt = joinAt ? new Date(joinAt) : new Date();
    this.leaveAt = leaveAt ? new Date(leaveAt) : new Date(Date.now() + 3 * 3600_000);
    this.webhookUrl = webhookUrl;
    this.introMessage = introMessage || null;
    this.agendaMessage = agendaMessage || null;
    this.raiseMessage = raiseMessage || null;
    this.readChat = Boolean(readChat);
    this.deps = deps;   // { log, aloneMs, env, rtc?: the @livekit/rtc-node module (tests pass it in), fetch? }
    this.status = 'scheduled';
    this.error = null;
    this.lines = 0;
    this.chatQueue = [];
    this.voice = Boolean(voice);
    this.sayQueue = [];
    this.spoken = 0;
    this.voiceSource = null;
    this.stopping = false;
    this.webhookChain = Promise.resolve();
    this.speechChain = Promise.resolve();
    this.liveSpeech = true;   // false once the API says it has no speech service: then Whisper after the call
    this.listening = new Map();   // participant identity -> { stop() }
    this.recording = null;        // { file, stream, bytes, timeline: [{name, at}] } for Whisper after the call
    this.identity = null;
    this.timer = setTimeout(() => void this.run(), Math.max(0, this.joinAt.getTime() - Date.now() - 30_000));
  }

  get summary() {
    return { id: this.id, status: this.status, error: this.error, lines: this.lines, joinAt: this.joinAt.toISOString(), leaveAt: this.leaveAt.toISOString() };
  }

  log(msg) { this.deps.log(`[call ${this.id.slice(0, 8)}] ${msg}`); }
  get fetch() { return this.deps.fetch ?? fetch; }

  post(event) {
    this.webhookChain = this.webhookChain.then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await this.fetch(this.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
          if (res.ok || res.status === 404 || res.status === 422) return;
        } catch { /* try again */ }
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
      this.log('webhook delivery failed');
    });
    return this.webhookChain;
  }

  setStatus(status, error = null) {
    this.status = status; this.error = error;
    void this.post({ event: 'bot.status', data: { status, error, bot: { id: this.id } } });
  }

  async run() {
    if (this.stopping) return;
    this.setStatus('joining');
    const rtc = this.deps.rtc ?? await import('@livekit/rtc-node');
    this.rtc = rtc;
    const room = new rtc.Room();
    this.room = room;
    try {
      room.on(rtc.RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind === rtc.TrackKind.KIND_AUDIO && !isAgent(participant)) this.listen(rtc, track, participant);
      });
      room.on(rtc.RoomEvent.TrackUnsubscribed, (_track, _pub, participant) => this.unlisten(participant?.identity));
      room.on(rtc.RoomEvent.ParticipantDisconnected, (participant) => this.unlisten(participant?.identity));
      room.on(rtc.RoomEvent.Disconnected, () => { this.disconnected = true; });
      if (this.readChat) {
        room.registerTextStreamHandler(CHAT_TOPIC, (reader, info) => {
          void reader.readAll().then((text) => {
            const who = room.remoteParticipants.get(info.identity);
            if (!isAgent(who)) this.heard(who?.name || info.identity, text);
          }).catch(() => undefined);
        });
      }
      await room.connect(this.liveKitUrl, this.liveKitToken, { autoSubscribe: true, dynacast: false });
      this.log('in the call (our own media server)');
      this.setStatus('in_call_recording');
      this.chatQueue.unshift(...[this.introMessage, this.agendaMessage, this.raiseMessage].filter(Boolean));
      await this.stayInCall();
      for (const id of [...this.listening.keys()]) this.unlisten(id);
      await this.speechChain;
      await room.disconnect().catch(() => undefined);
      await this.finalTranscript();
      this.setStatus('call_ended');
    } catch (e) {
      this.log(`failed: ${e.message}`);
      this.setStatus('fatal', String(e.message || e).slice(0, 300));
      await room.disconnect().catch(() => undefined);
    } finally {
      await this.removeRecording();
      await this.webhookChain;
      if (this.status !== 'fatal') this.setStatus('done');
      this.deps.onFinished?.(this);
    }
  }

  async stayInCall() {
    let aloneSince = 0;
    const aloneMs = this.deps.aloneMs ?? 5 * 60_000;
    while (!this.stopping && !this.disconnected && Date.now() < this.leaveAt.getTime()) {
      while (this.chatQueue.length) {
        const message = this.chatQueue.shift();
        try { await this.room.localParticipant.sendText(message, { topic: CHAT_TOPIC }); } catch (e) { this.log(`chat: ${e.message}`); }
      }
      while (this.sayQueue.length && !this.stopping && !this.disconnected) await this.speak(this.sayQueue.shift());
      const people = [...this.room.remoteParticipants.values()].filter((p) => !isAgent(p)).length;
      if (people === 0) { aloneSince ||= Date.now(); if (Date.now() - aloneSince > aloneMs) { this.log('alone in the call'); return; } }
      else aloneSince = 0;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (this.disconnected) this.log('the call ended');
  }

  /** Reads one person's microphone (16 kHz mono) and cuts it into things they said. */
  listen(rtc, track, participant) {
    const id = participant.identity;
    this.unlisten(id);
    const name = String(participant.name || id).slice(0, 80);
    const segmenter = new Segmenter({ onUtterance: (pcm, at) => this.utterance(name, pcm, at) });
    const stream = new rtc.AudioStream(track, { sampleRate: RATE, numChannels: 1, frameSizeMs: FRAME_MS });
    const reader = stream.getReader();
    let stopped = false;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          segmenter.push(value.data, Date.now());
        }
      } catch { /* the track went away */ }
      segmenter.end();
    })();
    this.listening.set(id, { stop: () => { stopped = true; segmenter.end(); reader.cancel().catch(() => undefined); } });
    this.log(`listening to ${name}`);
  }

  unlisten(identity) {
    const l = identity && this.listening.get(identity);
    if (!l) return;
    this.listening.delete(identity);
    l.stop();
  }

  /** One thing someone said: to the API to be written down now, or into the recording for Whisper after the call. */
  utterance(name, pcm, at) {
    this.speechChain = this.speechChain.then(async () => {
      if (this.liveSpeech) {
        try {
          const form = new FormData();
          form.append('file', new Blob([wav(pcm)], { type: 'audio/wav' }), 'speech.wav');
          form.append('name', name);
          const res = await this.fetch(`${this.webhookUrl}/speech`, { method: 'POST', body: form, signal: AbortSignal.timeout(30_000) });
          if (res.ok) { const body = await res.json().catch(() => null); if ((body?.data ?? body)?.text) this.lines++; return; }
          if (res.status === 409) { this.liveSpeech = false; this.log('no speech service: the words are transcribed after the call'); }
          else this.log(`speech: the API answered ${res.status}`);
        } catch (e) { this.log(`speech: ${e.message}`); }
      }
      this.record(name, pcm, at);
    });
  }

  record(name, pcm, at) {
    if ((this.deps.env?.MEETBOT_WHISPER_MODEL ?? 'small') === 'off') return;
    if (!this.recording) {
      const file = path.join(tmpdir(), `pt-livekit-${this.id}.pcm`);
      this.recording = { file, stream: createWriteStream(file), samples: 0, timeline: [], startedAt: Date.now() };
    }
    const r = this.recording;
    // Utterances are laid end to end with a short gap; the timeline says who spoke at which point of the recording.
    r.timeline.push({ name, at: new Date(r.startedAt + Math.round((r.samples / RATE) * 1000)).toISOString(), heardAt: new Date(at).toISOString() });
    r.stream.write(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    const gap = new Int16Array(RATE / 2);
    r.stream.write(Buffer.from(gap.buffer));
    r.samples += pcm.length + gap.length;
  }

  async finalTranscript() {
    const r = this.recording;
    if (!r || r.samples < RATE) return;
    try {
      await new Promise((done) => r.stream.end(done));
      const { readFile, writeFile } = await import('node:fs/promises');
      const pcm = await readFile(r.file);
      const file = `${r.file}.wav`;
      await writeFile(file, wav(new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))));
      r.wavFile = file;
      this.setStatus('transcribing');
      const segments = await transcribe(file, this.deps.env ?? process.env, (m) => this.log(m));
      if (!segments?.length) return;
      const lines = align(segments, r.timeline, r.startedAt);
      await this.post({ event: 'transcript.final', data: { lines, bot: { id: this.id } } });
      this.lines = lines.length;
      this.log(`transcript after the call: ${lines.length} lines`);
    } catch (e) { this.log(`transcript after the call skipped: ${e.message}`); }
  }

  async removeRecording() {
    const r = this.recording;
    if (!r) return;
    r.stream.destroy();
    await rm(r.file, { force: true }).catch(() => undefined);
    if (r.wavFile) await rm(r.wavFile, { force: true }).catch(() => undefined);
    this.recording = null;
  }

  heard(name, text) {
    const message = String(text).replace(/\s+/g, ' ').trim();
    if (!message) return;
    void this.post({ event: 'chat.message', data: { name: String(name || 'Someone').slice(0, 80), text: message.slice(0, 1000), bot: { id: this.id } } });
  }

  chat(message) {
    if (['call_ended', 'done', 'fatal'].includes(this.status) || this.stopping) return false;
    this.chatQueue.push(String(message).slice(0, 500));
    return true;
  }

  /** Lines to say out loud (only when the meeting asked for voice). */
  say(list) {
    if (!this.voice || ['call_ended', 'done', 'fatal'].includes(this.status) || this.stopping) return false;
    this.sayQueue.push(...sayItems(list));
    this.sayQueue.splice(0, Math.max(0, this.sayQueue.length - 4));
    return true;
  }

  /**
   * Says one line: the voice goes out on the agent's own microphone track (published the first time it speaks, so a quiet notetaker never
   * shows a microphone at all). Everyone hears it like any other person in the call.
   */
  async speak(item) {
    const voice = parseWav(Buffer.from(item.audio, 'base64'));
    if (!voice || voice.pcm.length === 0) { this.log('voice: not a WAV file'); return; }
    const rtc = this.rtc;
    try {
      if (!this.voiceSource || this.voiceSource.sampleRate !== voice.rate) {
        if (this.voiceTrackSid) await this.room.localParticipant.unpublishTrack(this.voiceTrackSid).catch(() => undefined);
        this.voiceSource = new rtc.AudioSource(voice.rate, 1);
        const track = rtc.LocalAudioTrack.createAudioTrack('agent-voice', this.voiceSource);
        const options = new rtc.TrackPublishOptions(); options.source = rtc.TrackSource.SOURCE_MICROPHONE;
        const pub = await this.room.localParticipant.publishTrack(track, options);
        this.voiceTrackSid = pub?.sid;
        await new Promise((r) => setTimeout(r, 300));   // let the others subscribe before the first word
      }
      const step = Math.max(1, Math.round(voice.rate / 100));   // 10 ms frames
      for (let i = 0; i < voice.pcm.length && !this.stopping && !this.disconnected; i += step) {
        const chunk = new Int16Array(step);
        chunk.set(voice.pcm.subarray(i, i + step));
        await this.voiceSource.captureFrame(new rtc.AudioFrame(chunk, voice.rate, 1, step));
      }
      await this.voiceSource.waitForPlayout?.();
      this.spoken++;
    } catch (e) { this.log(`voice: ${e.message}`); }
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    if (this.status === 'scheduled') { this.status = 'done'; this.deps.onFinished?.(this); }
  }
}
